import { networkInterfaces } from "os";
import {
  RTCDataChannel,
  RTCPeerConnection,
  type RTCSessionDescriptionInit,
} from "werift";
import { BrowserCameraPacketQueue, type BrowserCameraPacketSink } from "./browser-camera-packets";
import { closeBrowserCameraFrameStream } from "./camera-helper";

export const BROWSER_CAMERA_WEBRTC_PORT_RANGE: [number, number] = [55000, 55100];
const CONNECTION_TIMEOUT_MS = 15_000;
const DISCONNECTED_GRACE_MS = 5_000;

export function browserCameraWebRtcHostAddresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && entry.family === "IPv4")
    .map((entry) => entry.address);
  return [...new Set(addresses)];
}

class BrowserCameraWebRtcSession {
  private readonly peer: RTCPeerConnection;
  private readonly packets: BrowserCameraPacketQueue;
  private control: RTCDataChannel | null = null;
  private frames: RTCDataChannel | null = null;
  private closed = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly device: string,
    sink: BrowserCameraPacketSink,
    private readonly onClose: () => void,
  ) {
    this.peer = new RTCPeerConnection({
      iceServers: [],
      iceUseIpv4: true,
      iceUseIpv6: false,
      icePortRange: BROWSER_CAMERA_WEBRTC_PORT_RANGE,
      iceAdditionalHostAddresses: browserCameraWebRtcHostAddresses(),
      maxMessageSize: 2 * 1024 * 1024,
    });
    this.packets = new BrowserCameraPacketQueue(device, sink, (value) => {
      if (this.control?.readyState === "open") this.control.send(JSON.stringify(value));
    });
    this.peer.onDataChannel.subscribe((channel) => this.attachChannel(channel));
    this.peer.connectionStateChange.subscribe((state) => {
      if (state === "connected") {
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      } else if (state === "disconnected") {
        if (!this.disconnectTimer) {
          this.disconnectTimer = setTimeout(() => { void this.close(); }, DISCONNECTED_GRACE_MS);
        }
      } else if (state === "failed" || state === "closed") {
        void this.close();
      }
    });
    this.connectionTimer = setTimeout(() => { void this.close(); }, CONNECTION_TIMEOUT_MS);
  }

  async answer(offer: RTCSessionDescriptionInit): Promise<{ type: "answer"; sdp: string }> {
    await this.peer.setRemoteDescription(offer);
    await this.peer.setLocalDescription(await this.peer.createAnswer());
    const answer = this.peer.localDescription;
    if (!answer || answer.type !== "answer") throw new Error("WebRTC answer was not created");
    return { type: "answer", sdp: answer.sdp };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.packets.close();
    closeBrowserCameraFrameStream(this.device);
    try { await this.peer.close(); } catch {}
    this.onClose();
  }

  private attachChannel(channel: RTCDataChannel): void {
    if (channel.label === "camera-control") {
      this.control?.close();
      this.control = channel;
      channel.onMessage.subscribe((message) => {
        if (Buffer.isBuffer(message) && !this.packets.receive(message)) {
          channel.send(JSON.stringify({ error: "Invalid browser camera configuration" }));
        }
      });
    } else if (channel.label === "camera-frames") {
      this.frames?.close();
      this.frames = channel;
      channel.onMessage.subscribe((message) => {
        if (Buffer.isBuffer(message) && !this.packets.receive(message)) {
          if (this.control?.readyState === "open") {
            this.control.send(JSON.stringify({ error: "Invalid browser camera frame" }));
          }
        }
      });
    } else {
      channel.close();
      return;
    }

    channel.stateChanged.subscribe((state) => {
      if (state === "closed") void this.close();
      if (state === "open" && this.control?.readyState === "open" && this.frames?.readyState === "open") {
        this.control.send(JSON.stringify({ ready: true, transport: "webrtc" }));
      }
    });
  }
}

const sessions = new Map<string, BrowserCameraWebRtcSession>();

export async function answerBrowserCameraWebRtc(
  device: string,
  offer: RTCSessionDescriptionInit,
  sink: BrowserCameraPacketSink,
): Promise<{ type: "answer"; sdp: string }> {
  await sessions.get(device)?.close();
  let session: BrowserCameraWebRtcSession;
  session = new BrowserCameraWebRtcSession(device, sink, () => {
    if (sessions.get(device) === session) sessions.delete(device);
  });
  sessions.set(device, session);
  try {
    return await session.answer(offer);
  } catch (error) {
    await session.close();
    throw error;
  }
}

export async function closeBrowserCameraWebRtc(device: string): Promise<void> {
  await sessions.get(device)?.close();
}
