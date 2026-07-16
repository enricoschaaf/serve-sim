/**
 * In-process device session — the replacement for the spawned serve-sim-bin
 * helper. One session per booted simulator owns a NativeCapture + NativeHid and
 * serves the same wire endpoints the helper's HTTP server did, byte-for-byte:
 *
 *   /stream.mjpeg  multipart/x-mixed-replace JPEG fan-out (?raw=1 → octet-stream)
 *   /stream.avcc   length-prefixed AVCC envelopes (seed + decoder config replay)
 *   /ws            binary HID input protocol ([tag][JSON]) → NativeHid
 *   /config        { width, height, orientation }
 *   /health        { status: "ok" }
 *   /ax            axe-shaped accessibility JSON (one-shot)
 *   /foreground    { bundleId, pid }
 *   /settle         wait for framebuffer motion to stop
 *   /run            execute a typed agent interaction batch
 *   /recording/*   start/stop/discard motion-compacted recording
 *
 * Replaces the helper's HTTP/client layer; the framing here mirrors the
 * original byte-for-byte so the existing browser client is unchanged.
 */
import type { IncomingMessage, ServerResponse } from "http";
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import { mkdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";
import {
  NativeCapture,
  NativeHid,
  Orientation,
  axDescribeAsync,
  axFrontmostAsync,
  type MjpegFrame,
} from "./native";
import { eventLogEventForHidMessage, formatEventLogPoint, recordEventLogEvent, updateEventLogEvent } from "./event-log";
import {
  closeAllXCTestRunners,
  invalidateXCTestForeground,
  prewarmXCTestRunner,
  xctestDescribe,
  xctestRunnerStatus,
} from "./xctest-runner";
import { compactRecording } from "./recording";
import { runAgentBatch, type AgentAdapter, type AgentRunnerState } from "./agent-runner";
import { textToKeyEvents } from "./text-to-keys";

/**
 * Minimal WebSocket surface the HID input channel needs. Satisfied by both the
 * `ws` library and the raw-socket adapter the middleware uses under Bun (where
 * `ws`'s server-side handshake doesn't flush). Messages arrive as binary
 * `[tag][JSON]` frames; `send` writes a binary frame.
 */
export interface HidSocket {
  send(data: Buffer): void;
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "close" | "error", cb: () => void): void;
  close(): void;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// AVCC seed tag (StreamFormat.AVCCEnvelope.seedTag). description/keyframe/delta
// envelopes are framed natively; only the on-connect JPEG seed is built here.
const AVCC_SEED_TAG = 0x04;

// WS server→client screen-config push (ClientManager.wsMsgConfig).
const WS_MSG_CONFIG = 0x82;

const MJPEG_TRAILER = Buffer.from("\r\n", "ascii");
const TOUCH_TAP_MAX_DISTANCE = 0.004;

type TouchGestureLog = {
  eventId?: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moveCount: number;
  edge?: number;
};

type RecordingExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

type ActiveRecording = {
  child: ChildProcess;
  exit: Promise<RecordingExit>;
  rawPath: string;
  path: string;
  timer?: NodeJS.Timeout;
  blocked: boolean;
};

const RECORDING_FRAME_RATE = 15;
const RECORDING_START_SETTLE_MS = 150;
const RECORDING_STOP_TIMEOUT_MS = 5_000;
const RECORDING_FORCE_STOP_TIMEOUT_MS = 2_000;
const SETTLE_MIN_QUIET_MS = 40;
const SETTLE_MAX_QUIET_MS = 2_000;
const SETTLE_MAX_TIMEOUT_MS = 30_000;
const AGENT_REQUEST_MAX_BYTES = 1024 * 1024;

function touchGestureSummary(gesture: TouchGestureLog): string {
  return `Drag ${formatEventLogPoint(gesture.startX, gesture.startY)} -> ${formatEventLogPoint(gesture.lastX, gesture.lastY)}`;
}

function touchGestureMoved(gesture: TouchGestureLog): boolean {
  const dx = gesture.lastX - gesture.startX;
  const dy = gesture.lastY - gesture.startY;
  return Math.hypot(dx, dy) > TOUCH_TAP_MAX_DISTANCE;
}

function newTouchGesture(payload: { x: number; y: number; edge?: number }): TouchGestureLog {
  return {
    startX: payload.x,
    startY: payload.y,
    lastX: payload.x,
    lastY: payload.y,
    moveCount: 0,
    edge: payload.edge,
  };
}

function mjpegHeader(jpegLength: number): Buffer {
  return Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegLength}\r\n\r\n`, "ascii");
}

function avccSeed(jpeg: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + jpeg.length);
  out.writeUInt32BE(jpeg.length + 1, 0); // length covers the tag byte + payload
  out[4] = AVCC_SEED_TAG;
  out.set(jpeg, 5);
  return out;
}

const ORIENTATION_BY_NAME: Record<string, number> = {
  portrait: Orientation.portrait,
  portrait_upside_down: Orientation.portraitUpsideDown,
  landscape_left: Orientation.landscapeLeft,
  landscape_right: Orientation.landscapeRight,
};

function waitForDrain(res: ServerResponse): Promise<void> {
  if (res.writableEnded || res.destroyed || !res.writableNeedDrain) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

export class DeviceSession {
  private readonly capture: NativeCapture;
  private readonly hid: NativeHid;
  private unsubscribeMjpeg?: () => void;
  private phase: "unstarted" | "running" | "stopped" = "unstarted";

  private width = 0;
  private height = 0;
  private orientation = "portrait";

  private latestJpegBuffer: Buffer | null = null;
  private latestJpegLength = 0;
  private visualGeneration = 0;
  private lastVisualChangeAt = Date.now();
  private readonly visualWaiters = new Set<() => void>();
  private readonly hidSockets = new Set<HidSocket>();
  private touchGestureLog?: TouchGestureLog;
  private recording?: ActiveRecording;
  private agentRunActive = false;
  private agentState: AgentRunnerState = { generation: 0 };

  constructor(public readonly udid: string) {
    this.hid = new NativeHid(udid);
    this.capture = new NativeCapture(udid);
  }

  /** Begin capture. Throws if the device isn't booted. Idempotent. */
  start(): void {
    if (this.phase !== "unstarted") return;
    prewarmXCTestRunner(this.udid);
    this.capture.start();
    void (async () => {
      const unsubscribe = await this.capture.subscribeMjpeg((frame) => this.onSharedMjpegFrame(frame));
      if (this.phase === "running") { // only if someone hasn't already stopped the capture
        this.unsubscribeMjpeg = unsubscribe;
      } else {
        unsubscribe();
      }
    })();
    this.phase = "running";
  }

  close(): void {
    if (this.phase !== "running") return;
    const recording = this.recording;
    this.recording = undefined;
    if (recording) {
      void discardRecording(recording);
    }
    for (const ws of this.hidSockets) ws.close();
    this.unsubscribeMjpeg?.();
    this.hidSockets.clear();
    this.capture.stop();
    this.phase = "stopped";
  }

  // ── Frame handling ───────────────────────────────────────────────────────

  private async onSharedMjpegFrame(frame: MjpegFrame): Promise<void> {
    const { width, height, data: jpeg } = frame;

    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.broadcastConfig();
    }

    const previous = this.latestJpeg();
    const changed = !previous
      || previous.length !== jpeg.length
      || !previous.equals(Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength));
    if (!this.latestJpegBuffer || this.latestJpegBuffer.length < jpeg.length) {
      const currentCapacity = this.latestJpegBuffer?.length ?? 0;
      this.latestJpegBuffer = Buffer.allocUnsafe(Math.max(jpeg.length, currentCapacity * 2));
    }
    this.latestJpegBuffer.set(jpeg, 0);
    this.latestJpegLength = jpeg.length;
    if (changed) {
      this.visualGeneration += 1;
      this.lastVisualChangeAt = Date.now();
      for (const resolve of this.visualWaiters) resolve();
      this.visualWaiters.clear();
    }
  }

  private latestJpeg(): Buffer | null {
    if (!this.latestJpegBuffer) return null;
    return this.latestJpegBuffer.subarray(0, this.latestJpegLength);
  }

  /** Write a multipart JPEG part (header + shared frame + boundary) without copying the JPEG. */
  private writeMjpegFrame(res: ServerResponse, jpeg: Uint8Array): void {
    res.write(mjpegHeader(jpeg.length));
    res.write(jpeg);
    res.write(MJPEG_TRAILER);
  }

  // ── HTTP handlers ────────────────────────────────────────────────────────

  handleMjpeg(req: IncomingMessage, res: ServerResponse): void {
    const raw = new URL(req.url ?? "", "http://x").searchParams.get("raw") === "1";
    res.writeHead(200, {
      "Content-Type": raw ? "application/octet-stream" : "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });

    void (async () => {
      const latestJpeg = this.latestJpeg();
      if (latestJpeg) this.writeMjpegFrame(res, latestJpeg); // paint immediately
      const unsubscribe = await this.capture.subscribeMjpeg(async (frame) => {
        await waitForDrain(res);
        this.writeMjpegFrame(res, frame.data);
      });
      if (res.writableEnded) unsubscribe();
      res.on("close", unsubscribe);
      res.on("error", unsubscribe);
    })();
  }

  handleAvcc(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });

    void (async () => {
      // Seed with the current screen; the per-client native AVCC subscription
      // starts with its own decoder config and keyframe.
      const latestJpeg = this.latestJpeg();
      if (latestJpeg) res.write(avccSeed(latestJpeg));

      const unsubscribe = await this.capture.subscribeAvcc(async (frame) => {
        await waitForDrain(res);
        res.write(frame.data);
      });
      if (res.writableEnded) unsubscribe();
      res.on("close", unsubscribe);
      res.on("error", unsubscribe);
    })();
  }

  handleConfig(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, this.screenConfig());
  }

  handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, { status: "ok", accessibility: xctestRunnerStatus(this.udid) });
  }

  async handleAx(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const xctest = await xctestDescribe(this.udid);
    res.setHeader("X-Serve-Sim-Frame-Generation", String(this.visualGeneration));
    return this.serveAxJson(
      res,
      () => xctest == null ? axDescribeAsync(this.udid) : Promise.resolve(xctest),
      "ax_unavailable",
    );
  }

  handleForeground(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.serveAxJson(res, () => axFrontmostAsync(this.udid), "foreground_unavailable");
  }

  async handleSettle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = new URL(req.url ?? "", "http://x").searchParams;
    const since = nonNegativeInteger(params.get("since"), this.visualGeneration);
    const quietMs = clamp(nonNegativeInteger(params.get("quiet_ms"), 120), SETTLE_MIN_QUIET_MS, SETTLE_MAX_QUIET_MS);
    const timeoutMs = clamp(nonNegativeInteger(params.get("timeout_ms"), 10_000), quietMs, SETTLE_MAX_TIMEOUT_MS);
    const startedAt = Date.now();
    const noChangeDeadline = startedAt + Math.max(quietMs, 200);
    const deadline = startedAt + timeoutMs;

    while (true) {
      const now = Date.now();
      const changed = this.visualGeneration > since;
      if (changed && now - this.lastVisualChangeAt >= quietMs) {
        this.sendJson(res, 200, { generation: this.visualGeneration, changed: true, timedOut: false });
        return;
      }
      if (!changed && now >= noChangeDeadline) {
        this.sendJson(res, 200, { generation: this.visualGeneration, changed: false, timedOut: false });
        return;
      }
      if (now >= deadline) {
        this.sendJson(res, 200, { generation: this.visualGeneration, changed, timedOut: true });
        return;
      }
      const target = changed ? this.lastVisualChangeAt + quietMs : noChangeDeadline;
      await this.waitForVisualChange(Math.max(1, Math.min(target, deadline) - now));
    }
  }

  async handleAgentRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.requirePost(req, res)) return;
    if (this.agentRunActive) {
      this.sendJson(res, 409, { error: "agent_run_active", message: "Another interaction batch is running" });
      return;
    }
    this.agentRunActive = true;
    const startedAt = Date.now();
    try {
      const body = await readJsonBody(req, AGENT_REQUEST_MAX_BYTES);
      const request = body as { operations?: unknown };
      const result = await runAgentBatch(this.agentAdapter(), request.operations, this.agentState);
      recordEventLogEvent({
        device: this.udid,
        source: "ui",
        kind: "agent-batch",
        action: "run",
        status: result.ok ? "ok" : "error",
        summary: `Agent batch ${result.ok ? "completed" : "failed"}`,
        details: {
          completed: result.completed,
          durationMs: Date.now() - startedAt,
          ...(result.ok ? {} : { failedStep: result.failedStep }),
        },
      });
      this.sendJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendJson(res, 400, { error: "invalid_agent_batch", message });
    } finally {
      this.agentRunActive = false;
    }
  }

  resetAgentState(): void {
    this.agentState = { generation: 0 };
  }

  async handleRecordingStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.requirePost(req, res)) return;
    if (this.recording) {
      this.sendJson(res, 409, { error: "recording_active", message: "A recording is already active" });
      return;
    }
    const directory = join(tmpdir(), "serve-sim", "recordings");
    await mkdir(directory, { recursive: true });
    const recordingId = `${this.udid}-${randomUUID()}`;
    const rawPath = join(directory, `${recordingId}.raw.mp4`);
    const path = join(directory, `${recordingId}.mp4`);
    const frame = this.latestJpeg();
    if (!frame) {
      this.sendJson(res, 503, { error: "frame_unavailable", message: "No simulator frame is available yet" });
      return;
    }
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", String(RECORDING_FRAME_RATE), "-i", "pipe:0",
      "-vf", "scale=min(640\\,iw):-2:flags=lanczos",
      "-an", "-r", String(RECORDING_FRAME_RATE),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-pix_fmt", "yuv420p", rawPath,
    ], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stdin?.on("error", (error) => {
      stderr = `${stderr}${error.message}`.slice(-4_000);
    });
    const exit = new Promise<RecordingExit>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, stderr: error.message }));
      child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
    });
    const recording: ActiveRecording = {
      child,
      exit,
      rawPath,
      path,
      blocked: false,
    };
    recording.timer = setInterval(() => this.writeRecordingFrame(recording), 1_000 / RECORDING_FRAME_RATE);
    child.stdin?.on("drain", () => { recording.blocked = false; });
    this.writeRecordingFrame(recording);
    this.recording = recording;
    const earlyExit = await Promise.race([
      exit,
      delay(RECORDING_START_SETTLE_MS).then(() => null),
    ]);
    if (earlyExit) {
      this.recording = undefined;
      if (recording.timer) clearInterval(recording.timer);
      recording.child.stdin?.end();
      await rm(rawPath, { force: true });
      this.sendJson(res, 500, {
        error: "recording_start_failed",
        message: earlyExit.stderr.trim() || `ffmpeg exited with code ${earlyExit.code}`,
      });
      return;
    }
    this.sendJson(res, 200, { message: "recording started" });
  }

  async handleRecordingStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.requirePost(req, res)) return;
    const recording = this.recording;
    if (!recording) {
      this.sendJson(res, 409, { error: "recording_inactive", message: "No recording is active" });
      return;
    }
    this.recording = undefined;
    try {
      if (recording.timer) clearInterval(recording.timer);
      recording.child.stdin?.end();
      const result = await stopRecordingProcess(recording);
      if (!result || result.code !== 0) {
        this.sendJson(res, 500, {
          error: "recording_stop_failed",
          message: result?.stderr.trim() || "ffmpeg did not finalize the recording",
        });
        return;
      }
      await compactRecording(recording.rawPath, recording.path);
      const size = (await stat(recording.path)).size;
      if (size === 0) {
        this.sendJson(res, 500, {
          error: "recording_empty",
          message: "ffmpeg produced an empty recording",
        });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(size),
        "Content-Disposition": "attachment; filename=simulator.mp4",
        "Cache-Control": "no-store",
        "X-Serve-Sim-Recording": "motion-compacted",
        ...CORS,
      });
      await pipeline(createReadStream(recording.path), res);
    } finally {
      await rm(recording.rawPath, { force: true });
      await rm(recording.path, { force: true });
    }
  }

  async handleRecordingDiscard(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.requirePost(req, res)) return;
    const discarded = await this.discardActiveRecording();
    if (discarded === null) {
      this.sendJson(res, 200, { message: "no active recording" });
      return;
    }
    if (!discarded) {
      this.sendJson(res, 500, {
        error: "recording_discard_failed",
        message: "ffmpeg did not stop",
      });
      return;
    }
    this.sendJson(res, 200, { message: "recording discarded" });
  }

  async discardActiveRecording(): Promise<boolean | null> {
    const recording = this.recording;
    this.recording = undefined;
    return recording ? await discardRecording(recording) : null;
  }

  private writeRecordingFrame(recording: ActiveRecording): void {
    if (recording.blocked || recording.child.stdin?.destroyed) return;
    const jpeg = this.latestJpeg();
    if (!jpeg) return;
    recording.blocked = !recording.child.stdin!.write(Buffer.from(jpeg));
  }

  private async waitForVisualChange(timeoutMs: number): Promise<void> {
    let resolveChange: () => void = () => {};
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
      this.visualWaiters.add(resolve);
    });
    await Promise.race([changed, delay(timeoutMs)]);
    this.visualWaiters.delete(resolveChange);
  }

  private agentAdapter(): AgentAdapter {
    return {
      describe: async () => {
        const xctest = await xctestDescribe(this.udid);
        const json = xctest ?? await axDescribeAsync(this.udid);
        return { tree: JSON.parse(json) as unknown, frameGeneration: this.visualGeneration };
      },
      screenshot: () => {
        const jpeg = this.latestJpeg();
        return jpeg ? Buffer.from(jpeg) : null;
      },
      tap: async (x, y) => {
        await this.sendAgentHid(0x03, { type: "begin", x, y });
        await delay(30);
        await this.sendAgentHid(0x03, { type: "end", x, y });
      },
      swipe: async (from, to, durationMs) => {
        await this.sendAgentHid(0x03, { type: "begin", x: from[0], y: from[1] });
        await this.interpolate(durationMs, (progress) => this.sendAgentHid(0x03, {
          type: "move",
          x: from[0] + (to[0] - from[0]) * progress,
          y: from[1] + (to[1] - from[1]) * progress,
        }));
        await this.sendAgentHid(0x03, { type: "end", x: to[0], y: to[1] });
      },
      scroll: (dx, dy, x, y) => this.sendAgentHid(0x0b, { dx, dy, ...(x == null ? {} : { x, y }) }),
      multiTouch: async (from, to, durationMs) => {
        await this.sendAgentHid(0x05, {
          type: "begin", x1: from[0], y1: from[1], x2: from[2], y2: from[3],
        });
        await this.interpolate(durationMs, (progress) => this.sendAgentHid(0x05, {
          type: "move",
          x1: from[0] + (to[0] - from[0]) * progress,
          y1: from[1] + (to[1] - from[1]) * progress,
          x2: from[2] + (to[2] - from[2]) * progress,
          y2: from[3] + (to[3] - from[3]) * progress,
        }));
        await this.sendAgentHid(0x05, {
          type: "end", x1: to[0], y1: to[1], x2: to[2], y2: to[3],
        });
      },
      type: async (text) => {
        for (const event of textToKeyEvents(text)) {
          await this.sendAgentHid(0x06, event);
          await delay(4);
        }
      },
      button: (name) => this.sendAgentHid(0x04, { button: name }),
      settle: (since, quietMs, timeoutMs) => this.settleAgent(since, quietMs, timeoutMs),
    };
  }

  private async sendAgentHid(tag: number, payload: Record<string, unknown>): Promise<void> {
    await this.handleHidMessage(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
  }

  private async interpolate(durationMs: number, action: (progress: number) => Promise<void>): Promise<void> {
    const steps = Math.max(2, Math.min(24, Math.round(durationMs / 16)));
    const interval = durationMs / steps;
    for (let step = 1; step < steps; step++) {
      await action(step / steps);
      await delay(interval);
    }
  }

  private async settleAgent(since: number, quietMs: number, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    const noChangeDeadline = startedAt + Math.max(quietMs, 200);
    const deadline = startedAt + timeoutMs;
    while (true) {
      const now = Date.now();
      const changed = this.visualGeneration > since;
      if (changed && now - this.lastVisualChangeAt >= quietMs) return;
      if (!changed && now >= noChangeDeadline) return;
      if (now >= deadline) throw new Error("timed out waiting for the screen to settle");
      const target = changed ? this.lastVisualChangeAt + quietMs : noChangeDeadline;
      await this.waitForVisualChange(Math.max(1, Math.min(target, deadline) - now));
    }
  }

  /** Run a native AX probe and stream its JSON, or 503 with `errorCode` if it's not ready. */
  private async serveAxJson(res: ServerResponse, probe: () => Promise<string>, errorCode: string): Promise<void> {
    try {
      const json = await probe();
      if (res.writableEnded) return;
      this.sendJsonString(res, 200, json);
    } catch (err) {
      if (res.writableEnded) return;
      this.sendJson(res, 503, {
        error: errorCode,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private requirePost(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method === "POST") return true;
    res.writeHead(405, {
      Allow: "POST",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS,
    });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return false;
  }

  // ── HID WebSocket ────────────────────────────────────────────────────────

  attachHidSocket(ws: HidSocket): void {
    this.hidSockets.add(ws);
    const cfg = this.configFrame();
    if (cfg) ws.send(cfg); // seed dimensions/orientation, replacing the old poll
    ws.on("message", (data: Buffer) => this.handleHidMessage(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    ws.on("close", () => this.hidSockets.delete(ws));
    ws.on("error", () => this.hidSockets.delete(ws));
  }

  private async handleHidMessage(data: Buffer): Promise<void> {
    if (data.length < 1) return;
    const tag = data[0];
    const body = data.length > 1 ? data.subarray(1) : null;
    const json = <T>(): T | null => {
      if (!body) return null;
      try {
        return JSON.parse(body.toString("utf8")) as T;
      } catch {
        return null;
      }
    };
    const W = this.width;
    const H = this.height;

    switch (tag) {
      case 0x03: {
        const m = json<{ type: string; x: number; y: number; edge?: number }>();
        if (m) {
          this.recordTouchEvent(m);
          this.hid.touch(m.type as "begin" | "move" | "end", m.x, m.y, W, H, m.edge ?? 0);
        }
        break;
      }
      case 0x04: {
        const m = json<{ button: string; page?: number; usage?: number; phase?: string }>();
        if (!m) break;
        this.recordHidEvent(tag, m);
        if (m.button === "home") invalidateXCTestForeground(this.udid);
        if (m.page != null && m.usage != null) {
          this.hid.buttonHid(m.page, m.usage, (m.phase as "down" | "up" | "press") ?? "press");
        } else {
          this.hid.button(m.button);
        }
        break;
      }
      case 0x05: {
        const m = json<{ type: string; x1: number; y1: number; x2: number; y2: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.multiTouch(m.type as "begin" | "move" | "end", m.x1, m.y1, m.x2, m.y2, W, H);
        }
        break;
      }
      case 0x06: {
        const m = json<{ type: string; usage: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.key(m.type as "down" | "up", m.usage);
        }
        break;
      }
      case 0x07: {
        const m = json<{ orientation: string }>();
        if (!m) break;
        const value = ORIENTATION_BY_NAME[m.orientation];
        if (value != null && await this.hid.orientation(value)) {
          this.recordHidEvent(tag, m);
          if (m.orientation !== this.orientation) {
            this.orientation = m.orientation;
            this.broadcastConfig();
          }
        }
        break;
      }
      case 0x08: {
        const m = json<{ option: string; enabled: boolean }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.caDebug(m.option, m.enabled);
        }
        break;
      }
      case 0x09:
        this.recordHidEvent(tag, {});
        this.hid.memoryWarning();
        break;
      case 0x0a: {
        const m = json<{ delta: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.digitalCrown(m.delta);
        }
        break;
      }
      case 0x0b: {
        // Payload deltas are a fraction of the display; scale to device pixels.
        const m = json<{ dx: number; dy: number; x?: number; y?: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.scroll(m.dx * W, m.dy * H, W, H, m.x, m.y);
        }
        break;
      }
      case 0x0c:
        this.recordHidEvent(tag, {});
        this.hid.softwareKeyboard();
        break;
    }
  }

  private recordTouchEvent(payload: { type: string; x: number; y: number; edge?: number }): void {
    if (payload.type === "begin") {
      this.touchGestureLog = newTouchGesture(payload);
      return;
    }

    if (payload.type === "move") {
      let gesture = this.touchGestureLog;
      if (!gesture) {
        gesture = newTouchGesture(payload);
        this.touchGestureLog = gesture;
      }

      gesture.lastX = payload.x;
      gesture.lastY = payload.y;
      gesture.moveCount++;
      if (payload.edge != null) gesture.edge = payload.edge;
      if (touchGestureMoved(gesture)) {
        if (gesture.eventId == null) {
          const entry = recordEventLogEvent({
            device: this.udid,
            source: "hid",
            kind: "drag",
            action: "drag",
            summary: touchGestureSummary(gesture),
            details: this.touchGestureDetails(gesture, "drag", "move"),
          });
          gesture.eventId = entry.id;
        } else {
          // Keep the stored drag current without streaming every touchmove to the browser.
          updateEventLogEvent(
            gesture.eventId,
            {
              kind: "drag",
              action: "drag",
              summary: touchGestureSummary(gesture),
              details: this.touchGestureDetails(gesture, "drag", "move"),
            },
            { notify: false },
          );
        }
      }
      return;
    }

    if (payload.type === "end") {
      const gesture = this.touchGestureLog;
      if (gesture) {
        gesture.lastX = payload.x;
        gesture.lastY = payload.y;
        if (payload.edge != null) gesture.edge = payload.edge;
        if (gesture.moveCount > 0 && touchGestureMoved(gesture)) {
          if (gesture.eventId == null) {
            recordEventLogEvent({
              device: this.udid,
              source: "hid",
              kind: "drag",
              action: "drag",
              summary: touchGestureSummary(gesture),
              details: this.touchGestureDetails(gesture, "drag", "end"),
            });
          } else {
            updateEventLogEvent(gesture.eventId, {
              kind: "drag",
              action: "drag",
              summary: touchGestureSummary(gesture),
              details: this.touchGestureDetails(gesture, "drag", "end"),
            });
          }
        } else {
          recordEventLogEvent({
            device: this.udid,
            source: "hid",
            kind: "tap",
            action: "tap",
            summary: `Tap ${formatEventLogPoint(payload.x, payload.y)}`,
            details: this.touchGestureDetails(gesture, "tap"),
          });
        }
        this.touchGestureLog = undefined;
        return;
      }
    }

    this.recordHidEvent(0x03, payload);
  }

  private eventLogScreen(): { width: number; height: number } | undefined {
    return this.width > 0 && this.height > 0
      ? { width: this.width, height: this.height }
      : undefined;
  }

  private touchGestureDetails(
    gesture: TouchGestureLog,
    type: "drag" | "tap",
    phase?: "move" | "end",
  ): Record<string, unknown> {
    return {
      type,
      ...(phase ? { phase } : {}),
      start: { x: gesture.startX, y: gesture.startY },
      current: { x: gesture.lastX, y: gesture.lastY },
      moveCount: gesture.moveCount,
      ...(gesture.edge != null ? { edge: gesture.edge } : {}),
      ...(this.eventLogScreen() ? { screen: this.eventLogScreen() } : {}),
    };
  }

  private recordHidEvent(tag: number, payload: Record<string, unknown>): void {
    const event = eventLogEventForHidMessage(
      this.udid,
      tag,
      payload,
      this.eventLogScreen(),
    );
    if (event) recordEventLogEvent(event);
  }

  // ── Config ───────────────────────────────────────────────────────────────

  screenConfig(): { width: number; height: number; orientation: string } {
    return { width: this.width, height: this.height, orientation: this.orientation };
  }

  private configFrame(): Buffer | null {
    if (this.width === 0 && this.height === 0) return null;
    return Buffer.concat([Buffer.from([WS_MSG_CONFIG]), Buffer.from(JSON.stringify(this.screenConfig()))]);
  }

  private broadcastConfig(): void {
    const frame = this.configFrame();
    if (!frame) return;
    for (const ws of this.hidSockets) ws.send(frame);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    this.sendJsonString(res, status, JSON.stringify(body));
  }

  private sendJsonString(res: ServerResponse, status: number, json: string): void {
    const buf = Buffer.from(json, "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store",
      "Content-Length": String(buf.length),
      ...CORS,
    });
    res.end(buf);
  }
}

async function stopRecordingProcess(recording: ActiveRecording): Promise<RecordingExit | null> {
  let result = await waitForRecordingExit(recording.exit, RECORDING_STOP_TIMEOUT_MS);
  if (result) return result;
  recording.child.kill("SIGTERM");
  result = await waitForRecordingExit(recording.exit, RECORDING_FORCE_STOP_TIMEOUT_MS);
  if (result) return result;
  recording.child.kill("SIGKILL");
  return await waitForRecordingExit(recording.exit, RECORDING_FORCE_STOP_TIMEOUT_MS);
}

async function discardRecording(recording: ActiveRecording): Promise<boolean> {
  if (recording.timer) clearInterval(recording.timer);
  recording.child.stdin?.end();
  try {
    return await stopRecordingProcess(recording) !== null;
  } finally {
    await rm(recording.rawPath, { force: true });
    await rm(recording.path, { force: true });
  }
}

async function waitForRecordingExit(
  exit: Promise<RecordingExit>,
  timeoutMs: number,
): Promise<RecordingExit | null> {
  return await Promise.race([exit, delay(timeoutMs).then(() => null)]);
}

function nonNegativeInteger(value: string | null, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("request body is empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

// ── Registry ─────────────────────────────────────────────────────────────

const sessions = new Map<string, DeviceSession>();

/**
 * Get (lazily creating + starting) the in-process session for `udid`. Throws if
 * the device isn't booted. The session lives until `closeDeviceSession`.
 */
export function getDeviceSession(udid: string): DeviceSession {
  let session = sessions.get(udid);
  if (!session) {
    session = new DeviceSession(udid);
    try {
      session.start();
    } catch (err) {
      session.close();
      throw err;
    }
    sessions.set(udid, session);
  }
  return session;
}

export function closeDeviceSession(udid: string): void {
  const session = sessions.get(udid);
  if (session) {
    session.close();
    sessions.delete(udid);
  }
}

export async function discardDeviceRecording(udid: string): Promise<boolean> {
  const session = sessions.get(udid);
  if (!session) return true;
  return await session.discardActiveRecording() !== false;
}

export function closeAllDeviceSessions(): void {
  for (const udid of sessions.keys()) closeDeviceSession(udid);
  closeAllXCTestRunners();
}
