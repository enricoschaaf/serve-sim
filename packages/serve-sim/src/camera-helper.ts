import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import net, { type Socket } from "net";
import { join } from "path";
import { STATE_DIR } from "./state";

export const CAMERA_STATE_DIR = join(STATE_DIR, "simcam");
const HELPER_TIMEOUT_MS = 3000;
const MAX_BROWSER_CAMERA_FRAME_BYTES = 1024 * 1024;

interface InjectedBundlesState {
  helperPid: number;
  bundleIds: string[];
}

export interface CameraHelperReply {
  [key: string]: unknown;
  ok?: boolean;
  source?: string;
  arg?: string;
  mirror?: string;
  error?: string;
}

export interface CameraStatusReply extends CameraHelperReply {
  udid: string;
  alive: boolean;
  helperPid?: number | null;
  bundleIds?: string[];
}

export function cameraHelperPidFile(udid: string): string {
  return join(CAMERA_STATE_DIR, `${udid}.pid`);
}

export function cameraHelperBundlesFile(udid: string): string {
  return join(CAMERA_STATE_DIR, `${udid}.bundles.json`);
}

export function cameraHelperSocketFile(udid: string): string {
  // POSIX sun_path is 104 chars on macOS, so keep this short.
  const short = createHash("sha1").update(udid).digest("hex").slice(0, 12);
  return `/tmp/serve-sim-cam-${short}.sock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readCameraHelperPid(udid: string): number | null {
  try {
    const pid = Number(readFileSync(cameraHelperPidFile(udid), "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function parseCameraHelperReply(value: unknown): CameraHelperReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid camera helper reply");
  }
  return value as CameraHelperReply;
}

export async function sendCameraHelperCommand(
  udid: string,
  command: object,
): Promise<CameraHelperReply> {
  const socketPath = cameraHelperSocketFile(udid);
  if (!existsSync(socketPath)) throw new Error("camera helper socket not found");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const settle = (error?: unknown, reply?: CameraHelperReply) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(reply ?? {});
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        settle(undefined, parseCameraHelperReply(JSON.parse(buffer.slice(0, newline)) as unknown));
      } catch (error) {
        settle(error);
      }
      socket.end();
    });
    socket.on("error", settle);
    socket.on("close", () => settle(new Error("socket closed")));
    timeout = setTimeout(() => {
      socket.destroy();
      settle(new Error("helper timeout"));
    }, HELPER_TIMEOUT_MS);
    socket.write(JSON.stringify(command) + "\n");
  });
}

class BrowserCameraFrameStream {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pending: {
    resolve: (reply: CameraHelperReply) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly onClose: () => void,
  ) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    if (!existsSync(this.socketPath)) throw new Error("camera helper socket not found");
    const socket = net.createConnection(this.socketPath);
    socket.setNoDelay(true);
    this.socket = socket;
    socket.on("data", (chunk) => this.handleData(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ));
    socket.on("error", (error) => this.close(error));
    socket.on("close", () => this.close(new Error("camera frame stream closed")));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const ready = this.nextReply();
    socket.write('{"action":"stream"}\n');
    const reply = await ready;
    if (!reply.ok || reply.stream !== true) {
      this.close(new Error(reply.error ?? "camera helper rejected frame stream"));
      throw new Error(reply.error ?? "camera helper rejected frame stream");
    }
  }

  async send(jpeg: Buffer): Promise<void> {
    if (jpeg.length === 0 || jpeg.length > MAX_BROWSER_CAMERA_FRAME_BYTES) {
      throw new Error("invalid browser camera frame");
    }
    await this.connect();
    const socket = this.socket;
    if (!socket) throw new Error("camera frame stream is unavailable");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(jpeg.length);
    const reply = this.nextReply();
    socket.write(length);
    socket.write(jpeg);
    const result = await reply;
    if (!result.ok) throw new Error(result.error ?? "camera helper rejected browser frame");
  }

  destroy(): void {
    this.close(new Error("camera frame stream closed"));
  }

  private nextReply(): Promise<CameraHelperReply> {
    if (this.pending) return Promise.reject(new Error("camera frame already in flight"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close(new Error("helper timeout"));
      }, HELPER_TIMEOUT_MS);
      this.pending = { resolve, reject, timeout };
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const newline = this.buffer.indexOf(0x0a);
    if (newline < 0) return;
    const line = this.buffer.subarray(0, newline).toString("utf8");
    this.buffer = this.buffer.subarray(newline + 1);
    const pending = this.pending;
    if (!pending) {
      this.close(new Error("unexpected camera helper reply"));
      return;
    }
    this.pending = null;
    clearTimeout(pending.timeout);
    try {
      pending.resolve(parseCameraHelperReply(JSON.parse(line) as unknown));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private close(error: Error): void {
    const socket = this.socket;
    if (!socket && !this.pending) return;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(error);
      this.pending = null;
    }
    if (socket && !socket.destroyed) socket.destroy();
    this.onClose();
  }
}

const browserCameraFrameStreams = new Map<string, BrowserCameraFrameStream>();

function browserCameraFrameStream(udid: string): BrowserCameraFrameStream {
  const existing = browserCameraFrameStreams.get(udid);
  if (existing) return existing;
  const stream = new BrowserCameraFrameStream(cameraHelperSocketFile(udid), () => {
    if (browserCameraFrameStreams.get(udid) === stream) {
      browserCameraFrameStreams.delete(udid);
    }
  });
  browserCameraFrameStreams.set(udid, stream);
  return stream;
}

export function closeBrowserCameraFrameStream(udid: string): void {
  browserCameraFrameStreams.get(udid)?.destroy();
}

export async function sendBrowserCameraFrame(udid: string, jpeg: Buffer): Promise<void> {
  await browserCameraFrameStream(udid).send(jpeg);
}

export function isCameraHelperAlive(udid: string): boolean {
  const pid = readCameraHelperPid(udid);
  return pid !== null && isProcessAlive(pid) && existsSync(cameraHelperSocketFile(udid));
}

export function readInjectedCameraBundles(udid: string): string[] {
  let state: InjectedBundlesState;
  try {
    const value = JSON.parse(readFileSync(cameraHelperBundlesFile(udid), "utf-8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Partial<InjectedBundlesState>;
    if (typeof candidate.helperPid !== "number" || !Array.isArray(candidate.bundleIds)) return [];
    state = { helperPid: candidate.helperPid, bundleIds: candidate.bundleIds };
  } catch {
    return [];
  }
  const currentHelperPid = readCameraHelperPid(udid);
  if (currentHelperPid === null || state.helperPid !== currentHelperPid) return [];
  return state.bundleIds.filter((bundleId): bundleId is string => typeof bundleId === "string");
}

export async function readCameraStatus(udid: string): Promise<CameraStatusReply> {
  if (!isCameraHelperAlive(udid)) return { udid, alive: false };

  const helperPid = readCameraHelperPid(udid);
  const bundleIds = readInjectedCameraBundles(udid);
  try {
    const reply = await sendCameraHelperCommand(udid, { action: "status" });
    return { ...reply, udid, alive: true, helperPid, bundleIds };
  } catch (error) {
    return {
      udid,
      alive: true,
      helperPid,
      bundleIds,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
