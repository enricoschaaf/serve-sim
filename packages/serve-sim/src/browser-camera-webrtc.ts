import { networkInterfaces } from "os";
import {
  RTCDataChannel,
  RTCPeerConnection,
  useH264,
  useTransportWideCC,
  type MediaStreamTrack,
  type RTCSessionDescriptionInit,
} from "werift";
import type { BrowserCameraPacketSink } from "./browser-camera-packets";
import { BrowserCameraMediaPump, BrowserCameraRtpAssembler } from "./browser-camera-rtp";
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
  private readonly pump: BrowserCameraMediaPump;
  private readonly assembler = new BrowserCameraRtpAssembler();
  private control: RTCDataChannel | null = null;
  private remoteTrack: MediaStreamTrack | null = null;
  private remoteSsrc: number | null = null;
  private closed = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private receivedPackets = 0;
  private receivedBytes = 0;
  private packetLossEvents = 0;

  constructor(
    readonly device: string,
    sink: BrowserCameraPacketSink,
    private readonly onClose: () => void,
  ) {
    this.peer = new RTCPeerConnection({
      codecs: { video: [useH264()] },
      headerExtensions: { video: [useTransportWideCC()] },
      iceServers: [],
      iceUseIpv4: true,
      iceUseIpv6: false,
      icePortRange: BROWSER_CAMERA_WEBRTC_PORT_RANGE,
      iceAdditionalHostAddresses: browserCameraWebRtcHostAddresses(),
      maxMessageSize: 2 * 1024 * 1024,
    });
    this.pump = new BrowserCameraMediaPump(device, sink, () => { void this.requestKeyframe(); });
    this.peer.onDataChannel.subscribe((channel) => this.attachChannel(channel));
    this.peer.onTrack.subscribe((track) => this.attachTrack(track));
    this.peer.connectionStateChange.subscribe((state) => {
      if (state === "connected") {
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        this.startTelemetry();
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
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.pump.close();
    this.remoteTrack?.stop();
    this.remoteTrack = null;
    closeBrowserCameraFrameStream(this.device);
    try { await this.peer.close(); } catch {}
    this.onClose();
  }

  private attachChannel(channel: RTCDataChannel): void {
    if (channel.label === "camera-control") {
      this.control?.close();
      this.control = channel;
    } else {
      channel.close();
      return;
    }

    channel.stateChanged.subscribe((state) => {
      if (state === "closed") void this.close();
      if (state === "open" && this.control?.readyState === "open") {
        this.control.send(JSON.stringify({ ready: true, transport: "webrtc-media" }));
      }
    });
  }

  private attachTrack(track: MediaStreamTrack): void {
    if (track.kind !== "video") return;
    this.remoteTrack?.stop();
    this.remoteTrack = track;
    track.onReceiveRtp.subscribe((packet) => {
      if (this.closed) return;
      this.remoteSsrc = packet.header.ssrc;
      this.receivedPackets++;
      this.receivedBytes += packet.payload.length;
      const result = this.assembler.push(packet);
      if (result.packetLost) {
        this.packetLossEvents++;
        this.remoteSsrc = packet.header.ssrc;
        this.pump.requestRecovery();
      }
      if (result.frame) this.pump.receive(result.frame);
    });
  }

  private async requestKeyframe(mediaSsrc = this.remoteSsrc): Promise<void> {
    const track = this.remoteTrack;
    if (!track || mediaSsrc == null) return;
    const transceiver = this.peer.getTransceivers().find(
      (candidate) => candidate.receiver.track === track || candidate.receiver.tracks.includes(track),
    );
    if (!transceiver) return;
    try { await transceiver.receiver.sendRtcpPLI(mediaSsrc); } catch {}
  }

  private startTelemetry(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      if (this.control?.readyState !== "open") return;
      this.control.send(JSON.stringify({
        stats: {
          transport: "webrtc-media",
          receivedPackets: this.receivedPackets,
          receivedBytes: this.receivedBytes,
          packetLossEvents: this.packetLossEvents,
          ...this.pump.stats(),
        },
      }));
    }, 1_000);
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
