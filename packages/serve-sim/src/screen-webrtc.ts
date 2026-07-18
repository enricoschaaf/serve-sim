import { randomBytes } from "crypto";
import { networkInterfaces } from "os";
import {
  RTCDataChannel,
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useH264,
  useTransportWideCC,
  type RTCRtpSender,
  type RTCSessionDescriptionInit,
} from "werift";
import type { AvccFrame, AvccSubscriptionOptions } from "./native";

export const SCREEN_WEBRTC_PORT_RANGE: [number, number] = [55101, 55200];
const CONNECTION_TIMEOUT_MS = 15_000;
const DISCONNECTED_GRACE_MS = 5_000;
const RTP_CLOCK_RATE = 90_000;
const SCREEN_FRAMES_PER_SECOND = 30;
const RTP_TIMESTAMP_STEP = RTP_CLOCK_RATE / SCREEN_FRAMES_PER_SECOND;
const RTP_MAX_PAYLOAD_BYTES = 1_200;

export interface ScreenAvccSource {
  subscribeAvcc(
    onFrame: (frame: AvccFrame) => Promise<void>,
    options?: AvccSubscriptionOptions,
  ): Promise<() => void>;
  requestAvccKeyframe(): Promise<void>;
}

export type ScreenClientTelemetry = {
  viewportWidth?: number;
  devicePixelRatio?: number;
  visible?: boolean;
  active?: boolean;
  packetsLost?: number;
  packetsReceived?: number;
  roundTripTimeMs?: number;
  decoderDrops?: number;
  availableBitrate?: number;
};

export type ScreenStreamProfile = AvccSubscriptionOptions & {
  name: "full" | "balanced" | "compact" | "idle" | "hidden";
};

const SCREEN_PROFILES: Record<ScreenStreamProfile["name"], ScreenStreamProfile> = {
  full: { name: "full", maxDimension: 0, fps: 30, bitrate: 8_000_000 },
  balanced: { name: "balanced", maxDimension: 1_800, fps: 30, bitrate: 5_000_000 },
  compact: { name: "compact", maxDimension: 1_400, fps: 24, bitrate: 3_000_000 },
  idle: { name: "idle", maxDimension: 0, fps: 8, bitrate: 3_000_000 },
  hidden: { name: "hidden", maxDimension: 1_080, fps: 2, bitrate: 1_000_000 },
};

export function screenStreamProfile(telemetry: ScreenClientTelemetry): ScreenStreamProfile {
  if (telemetry.visible === false) return SCREEN_PROFILES.hidden;
  if (telemetry.active === false) return SCREEN_PROFILES.idle;
  const received = Math.max(0, telemetry.packetsReceived ?? 0);
  const lost = Math.max(0, telemetry.packetsLost ?? 0);
  const lossRatio = lost / Math.max(1, received + lost);
  const severelyConstrained = lossRatio >= 0.08 || (telemetry.roundTripTimeMs ?? 0) >= 500;
  const constrained = severelyConstrained
    || lossRatio >= 0.03
    || (telemetry.roundTripTimeMs ?? 0) >= 220
    || (telemetry.decoderDrops ?? 0) > 0;
  const availableBitrate = Math.max(0, telemetry.availableBitrate ?? 0);
  if (severelyConstrained
      || (availableBitrate > 0 && availableBitrate < 3_500_000)) {
    return SCREEN_PROFILES.compact;
  }
  if (constrained
      || (availableBitrate > 0 && availableBitrate < 6_000_000)) {
    return SCREEN_PROFILES.balanced;
  }
  return SCREEN_PROFILES.full;
}

export function screenWebRtcHostAddresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && entry.family === "IPv4")
    .map((entry) => entry.address);
  return [...new Set(addresses)];
}

type H264ParameterSets = {
  lengthSize: number;
  sps: Buffer[];
  pps: Buffer[];
};

export function unwrapAvccEnvelope(data: Uint8Array): Uint8Array {
  if (data.length < 5) throw new Error("Truncated AVCC envelope");
  const length = (
    data[0]! * 0x1_00_00_00
    + data[1]! * 0x1_00_00
    + data[2]! * 0x1_00
    + data[3]!
  );
  if (length < 1 || length + 4 !== data.length) throw new Error("Invalid AVCC envelope length");
  return data.subarray(5);
}

export function parseAvccDescription(description: Uint8Array): H264ParameterSets {
  if (description.length < 7 || description[0] !== 1) {
    throw new Error("Invalid H.264 avcC description");
  }
  const lengthSize = (description[4]! & 0x03) + 1;
  let offset = 6;
  const readSets = (count: number): Buffer[] => {
    const sets: Buffer[] = [];
    for (let index = 0; index < count; index++) {
      if (offset + 2 > description.length) throw new Error("Truncated H.264 parameter set");
      const length = (description[offset]! << 8) | description[offset + 1]!;
      offset += 2;
      if (length === 0 || offset + length > description.length) {
        throw new Error("Truncated H.264 parameter set");
      }
      sets.push(Buffer.from(description.subarray(offset, offset + length)));
      offset += length;
    }
    return sets;
  };
  const sps = readSets(description[5]! & 0x1f);
  if (offset >= description.length) throw new Error("Missing H.264 PPS count");
  const pps = readSets(description[offset++]!);
  if (sps.length === 0 || pps.length === 0) throw new Error("Missing H.264 parameter sets");
  return { lengthSize, sps, pps };
}

export function parseAvccNalus(frame: Uint8Array, lengthSize: number): Buffer[] {
  if (lengthSize < 1 || lengthSize > 4) throw new Error("Invalid H.264 NAL length size");
  const nalus: Buffer[] = [];
  let offset = 0;
  while (offset < frame.length) {
    if (offset + lengthSize > frame.length) throw new Error("Truncated H.264 NAL length");
    let length = 0;
    for (let index = 0; index < lengthSize; index++) {
      length = length * 256 + frame[offset + index]!;
    }
    offset += lengthSize;
    if (length === 0 || offset + length > frame.length) throw new Error("Truncated H.264 NAL unit");
    nalus.push(Buffer.from(frame.subarray(offset, offset + length)));
    offset += length;
  }
  return nalus;
}

function randomUint16(): number {
  return randomBytes(2).readUInt16BE(0);
}

function randomUint32(): number {
  return randomBytes(4).readUInt32BE(0);
}

export class H264RtpPacketizer {
  private sequenceNumber = randomUint16();
  private timestamp = randomUint32();
  private firstCaptureTimestampUs: number | null = null;
  private firstRtpTimestamp = this.timestamp;
  private parameterSets: H264ParameterSets | null = null;

  configure(description: Uint8Array): void {
    this.parameterSets = parseAvccDescription(description);
  }

  packetize(frame: Uint8Array, keyframe: boolean, captureTimestampUs = 0): RtpPacket[] {
    if (!this.parameterSets) return [];
    const frameNalus = parseAvccNalus(frame, this.parameterSets.lengthSize);
    const nalus = keyframe
      ? [...this.parameterSets.sps, ...this.parameterSets.pps, ...frameNalus]
      : frameNalus;
    const packets: RtpPacket[] = [];
    for (let naluIndex = 0; naluIndex < nalus.length; naluIndex++) {
      const nalu = nalus[naluIndex]!;
      const lastNalu = naluIndex === nalus.length - 1;
      if (nalu.length <= RTP_MAX_PAYLOAD_BYTES) {
        packets.push(this.packet(nalu, lastNalu, this.frameTimestamp(captureTimestampUs)));
        continue;
      }
      const indicator = (nalu[0]! & 0xe0) | 28;
      const type = nalu[0]! & 0x1f;
      const chunkBytes = RTP_MAX_PAYLOAD_BYTES - 2;
      for (let offset = 1; offset < nalu.length; offset += chunkBytes) {
        const end = Math.min(nalu.length, offset + chunkBytes);
        const firstFragment = offset === 1;
        const lastFragment = end === nalu.length;
        const header = type | (firstFragment ? 0x80 : 0) | (lastFragment ? 0x40 : 0);
        packets.push(this.packet(
          Buffer.concat([Buffer.from([indicator, header]), nalu.subarray(offset, end)]),
          lastNalu && lastFragment,
          this.frameTimestamp(captureTimestampUs),
        ));
      }
    }
    if (captureTimestampUs <= 0) this.timestamp = (this.timestamp + RTP_TIMESTAMP_STEP) >>> 0;
    return packets;
  }

  private frameTimestamp(captureTimestampUs: number): number {
    if (captureTimestampUs <= 0) return this.timestamp;
    if (this.firstCaptureTimestampUs === null) {
      this.firstCaptureTimestampUs = captureTimestampUs;
      this.firstRtpTimestamp = this.timestamp;
    }
    const elapsedUs = Math.max(0, captureTimestampUs - this.firstCaptureTimestampUs);
    return (this.firstRtpTimestamp + Math.round(elapsedUs * RTP_CLOCK_RATE / 1_000_000)) >>> 0;
  }

  private packet(payload: Buffer, marker: boolean, timestamp: number): RtpPacket {
    const packet = new RtpPacket(new RtpHeader({
      marker,
      payloadType: 96,
      sequenceNumber: this.sequenceNumber,
      timestamp,
      ssrc: 1,
    }), payload);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    return packet;
  }
}

class ScreenWebRtcSession {
  private readonly peer: RTCPeerConnection;
  private readonly track: MediaStreamTrack;
  private readonly sender: RTCRtpSender;
  private readonly packetizer = new H264RtpPacketizer();
  private control: RTCDataChannel | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  private starting = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private profile: ScreenStreamProfile = SCREEN_PROFILES.full;
  private profileChangedAt = 0;
  private candidateProfile: ScreenStreamProfile["name"] | null = null;
  private candidateSince = 0;
  private sourceFrames = 0;
  private sentPackets = 0;
  private sentBytes = 0;

  constructor(
    private readonly source: ScreenAvccSource,
    private readonly onClose: () => void,
    initialTelemetry: ScreenClientTelemetry = {},
  ) {
    this.profile = screenStreamProfile(initialTelemetry);
    this.profileChangedAt = Date.now();
    this.peer = new RTCPeerConnection({
      codecs: { video: [useH264()] },
      headerExtensions: { video: [useTransportWideCC()] },
      iceServers: [],
      iceUseIpv4: true,
      iceUseIpv6: false,
      icePortRange: SCREEN_WEBRTC_PORT_RANGE,
      iceAdditionalHostAddresses: screenWebRtcHostAddresses(),
    });
    this.track = new MediaStreamTrack({ kind: "video" });
    this.sender = this.peer.addTrack(this.track);
    this.sender.onPictureLossIndication.subscribe(() => { void this.source.requestAvccKeyframe(); });
    this.peer.onDataChannel.subscribe((channel) => this.attachControl(channel));
    this.peer.connectionStateChange.subscribe((state) => {
      if (state === "connected") {
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        void this.startSource();
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
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.track.stop();
    try { await this.peer.close(); } catch {}
    this.onClose();
  }

  private async startSource(): Promise<void> {
    if (this.closed || this.starting || this.unsubscribe) return;
    this.starting = true;
    try {
      const unsubscribe = await this.source.subscribeAvcc(async (frame) => {
        if (this.closed) return;
        let payload: Uint8Array;
        try { payload = unwrapAvccEnvelope(frame.data); } catch { return; }
        if (frame.isDescription) {
          try { this.packetizer.configure(payload); } catch {}
          return;
        }
        this.sourceFrames++;
        for (const packet of this.packetizer.packetize(payload, frame.isKeyframe, frame.timestampUs)) {
          this.track.writeRtp(packet);
          this.sentPackets++;
          this.sentBytes += packet.payload.length;
        }
      }, this.profile);
      if (this.closed) unsubscribe();
      else this.unsubscribe = unsubscribe;
    } finally {
      this.starting = false;
    }
  }

  private async restartSource(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.startSource();
  }

  private attachControl(channel: RTCDataChannel): void {
    if (channel.label !== "screen-control") {
      channel.close();
      return;
    }
    this.control?.close();
    this.control = channel;
    channel.onMessage.subscribe((message) => {
      try {
        const value = JSON.parse(message.toString()) as ScreenClientTelemetry;
        const remb = Number(this.sender.receiverEstimatedMaxBitrate);
        const twcc = this.sender.senderBWE.availableBitrate;
        const estimates = [remb, twcc].filter((bitrate) => Number.isFinite(bitrate) && bitrate > 0);
        if (estimates.length > 0) value.availableBitrate = Math.min(...estimates);
        this.considerProfile(screenStreamProfile(value), value);
      } catch {}
    });
    channel.stateChanged.subscribe((state) => {
      if (state === "open") channel.send(JSON.stringify({ profile: this.profile }));
    });
  }

  private considerProfile(profile: ScreenStreamProfile, telemetry: ScreenClientTelemetry): void {
    if (profile.name === this.profile.name) {
      this.candidateProfile = null;
      return;
    }
    const now = Date.now();
    const resumed = telemetry.visible !== false && telemetry.active !== false
      && (this.profile.name === "idle" || this.profile.name === "hidden");
    if (resumed) {
      this.applyProfile(profile, now);
      return;
    }
    if (this.candidateProfile !== profile.name) {
      this.candidateProfile = profile.name;
      this.candidateSince = now;
      return;
    }
    const requiredStableMs = this.qualityRank(profile.name) < this.qualityRank(this.profile.name)
      ? 1_500
      : 5_000;
    if (now - this.profileChangedAt < 5_000 || now - this.candidateSince < requiredStableMs) return;
    this.applyProfile(profile, now);
  }

  private applyProfile(profile: ScreenStreamProfile, now: number): void {
    this.profile = profile;
    this.profileChangedAt = now;
    this.candidateProfile = null;
    if (this.control?.readyState === "open") this.control.send(JSON.stringify({ profile }));
    void this.restartSource();
  }

  private qualityRank(name: ScreenStreamProfile["name"]): number {
    if (name === "full") return 4;
    if (name === "balanced") return 3;
    if (name === "compact") return 2;
    if (name === "idle") return 1;
    return 0;
  }

  private startTelemetry(): void {
    if (this.telemetryTimer) return;
    this.telemetryTimer = setInterval(() => {
      if (this.control?.readyState !== "open") return;
      this.control.send(JSON.stringify({
        stats: {
          transport: "webrtc-media",
          profile: this.profile,
          sourceFrames: this.sourceFrames,
          sentPackets: this.sentPackets,
          sentBytes: this.sentBytes,
          receiverEstimatedBitrate: Number(this.sender.receiverEstimatedMaxBitrate),
          transportWideCcBitrate: this.sender.senderBWE.availableBitrate,
        },
      }));
    }, 1_000);
  }
}

const sessions = new Map<string, Set<ScreenWebRtcSession>>();

export async function answerScreenWebRtc(
  device: string,
  offer: RTCSessionDescriptionInit,
  source: ScreenAvccSource,
  initialTelemetry: ScreenClientTelemetry = {},
): Promise<{ type: "answer"; sdp: string }> {
  let deviceSessions = sessions.get(device);
  if (!deviceSessions) {
    deviceSessions = new Set();
    sessions.set(device, deviceSessions);
  }
  let session: ScreenWebRtcSession;
  session = new ScreenWebRtcSession(source, () => {
    deviceSessions!.delete(session);
    if (deviceSessions!.size === 0) sessions.delete(device);
  }, initialTelemetry);
  deviceSessions.add(session);
  try {
    return await session.answer(offer);
  } catch (error) {
    await session.close();
    throw error;
  }
}

export async function closeScreenWebRtc(device: string): Promise<void> {
  const deviceSessions = sessions.get(device);
  if (!deviceSessions) return;
  await Promise.all([...deviceSessions].map((session) => session.close()));
}
