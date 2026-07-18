import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import net, { type Socket } from "net";
import { join } from "path";
import { STATE_DIR } from "./state";

export const CAMERA_STATE_DIR = join(STATE_DIR, "simcam");
const HELPER_TIMEOUT_MS = 3000;
const MAX_BROWSER_CAMERA_PACKET_BYTES = 2 * 1024 * 1024;

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

class BrowserCameraH264Stream {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private decoderConfiguration: Buffer | null = null;
  private pending: {
    resolve: (reply: CameraHelperReply) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(private readonly socketPath: string) {}

  async connect(replayConfiguration = true): Promise<void> {
    if (this.socket) return;
    if (!existsSync(this.socketPath)) throw new Error("camera helper socket not found");
    const socket = net.createConnection(this.socketPath);
    socket.setNoDelay(true);
    this.socket = socket;
    socket.on("data", (chunk) => this.handleData(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ));
    socket.on("error", (error) => this.closeSocket(socket, error));
    socket.on("close", () => this.closeSocket(socket, new Error("camera frame stream closed")));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const ready = this.nextReply();
    socket.write('{"action":"h264Stream"}\n');
    const reply = await ready;
    if (!reply.ok || reply.stream !== true) {
      this.closeSocket(socket, new Error(reply.error ?? "camera helper rejected frame stream"));
      throw new Error(reply.error ?? "camera helper rejected frame stream");
    }
    if (replayConfiguration && this.decoderConfiguration) {
      await this.writePacket(socket, this.decoderConfiguration);
    }
  }

  async send(packet: Buffer): Promise<void> {
    if (packet.length < 2 || packet.length > MAX_BROWSER_CAMERA_PACKET_BYTES
        || (packet[0] !== 1 && packet[0] !== 2)) {
      throw new Error("invalid browser camera H.264 packet");
    }
    const isConfiguration = packet[0] === 1;
    await this.connect(!isConfiguration);
    const socket = this.socket;
    if (!socket) throw new Error("camera frame stream is unavailable");
    if (isConfiguration) this.decoderConfiguration = Buffer.from(packet);
    await this.writePacket(socket, packet);
  }

  private async writePacket(socket: Socket, packet: Buffer): Promise<void> {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(packet.length);
    const headerNeedsDrain = !socket.write(length);
    const packetNeedsDrain = !socket.write(packet);
    if (headerNeedsDrain || packetNeedsDrain) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const cleanup = () => {
          socket.off("drain", onDrain);
          socket.off("error", onError);
        };
        socket.once("drain", onDrain);
        socket.once("error", onError);
      });
    }
  }

  destroy(): void {
    this.decoderConfiguration = null;
    const socket = this.socket;
    if (socket) this.closeSocket(socket, new Error("camera frame stream closed"));
  }

  private nextReply(): Promise<CameraHelperReply> {
    if (this.pending) return Promise.reject(new Error("camera frame already in flight"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const socket = this.socket;
        if (socket) this.closeSocket(socket, new Error("helper timeout"));
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
    try {
      const reply = parseCameraHelperReply(JSON.parse(line) as unknown);
      if (pending) {
        this.pending = null;
        clearTimeout(pending.timeout);
        pending.resolve(reply);
      } else if (!reply.ok) {
        const socket = this.socket;
        if (socket) this.closeSocket(socket, new Error(reply.error ?? "camera helper rejected browser frame"));
      }
    } catch (error) {
      if (pending) {
        this.pending = null;
        clearTimeout(pending.timeout);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private closeSocket(socket: Socket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(error);
      this.pending = null;
    }
    if (!socket.destroyed) socket.destroy();
  }
}

const browserCameraFrameStreams = new Map<string, BrowserCameraH264Stream>();

function browserCameraFrameStream(udid: string): BrowserCameraH264Stream {
  const existing = browserCameraFrameStreams.get(udid);
  if (existing) return existing;
  const stream = new BrowserCameraH264Stream(cameraHelperSocketFile(udid));
  browserCameraFrameStreams.set(udid, stream);
  return stream;
}

export function closeBrowserCameraFrameStream(udid: string): void {
  browserCameraFrameStreams.get(udid)?.destroy();
  browserCameraFrameStreams.delete(udid);
}

export async function sendBrowserCameraPacket(udid: string, packet: Buffer): Promise<void> {
  await browserCameraFrameStream(udid).send(packet);
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
