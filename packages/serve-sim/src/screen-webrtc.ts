import { randomBytes } from "crypto";
import { networkInterfaces } from "os";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useH264,
  type RTCSessionDescriptionInit,
} from "werift";
import type { AvccFrame } from "./native";

export const SCREEN_WEBRTC_PORT_RANGE: [number, number] = [55101, 55200];
const CONNECTION_TIMEOUT_MS = 15_000;
const DISCONNECTED_GRACE_MS = 5_000;
const RTP_CLOCK_RATE = 90_000;
const SCREEN_FRAMES_PER_SECOND = 30;
const RTP_TIMESTAMP_STEP = RTP_CLOCK_RATE / SCREEN_FRAMES_PER_SECOND;
const RTP_MAX_PAYLOAD_BYTES = 1_200;

export interface ScreenAvccSource {
  subscribeAvcc(onFrame: (frame: AvccFrame) => Promise<void>): Promise<() => void>;
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
  private parameterSets: H264ParameterSets | null = null;

  configure(description: Uint8Array): void {
    this.parameterSets = parseAvccDescription(description);
  }

  packetize(frame: Uint8Array, keyframe: boolean): RtpPacket[] {
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
        packets.push(this.packet(nalu, lastNalu));
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
        ));
      }
    }
    this.timestamp = (this.timestamp + RTP_TIMESTAMP_STEP) >>> 0;
    return packets;
  }

  private packet(payload: Buffer, marker: boolean): RtpPacket {
    const packet = new RtpPacket(new RtpHeader({
      marker,
      payloadType: 96,
      sequenceNumber: this.sequenceNumber,
      timestamp: this.timestamp,
      ssrc: 1,
    }), payload);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    return packet;
  }
}

class ScreenWebRtcSession {
  private readonly peer: RTCPeerConnection;
  private readonly track: MediaStreamTrack;
  private readonly packetizer = new H264RtpPacketizer();
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  private starting = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly source: ScreenAvccSource,
    private readonly onClose: () => void,
  ) {
    this.peer = new RTCPeerConnection({
      codecs: { video: [useH264()] },
      iceServers: [],
      iceUseIpv4: true,
      iceUseIpv6: false,
      icePortRange: SCREEN_WEBRTC_PORT_RANGE,
      iceAdditionalHostAddresses: screenWebRtcHostAddresses(),
    });
    this.track = new MediaStreamTrack({ kind: "video" });
    const sender = this.peer.addTrack(this.track);
    sender.onPictureLossIndication.subscribe(() => { void this.restartSource(); });
    this.peer.connectionStateChange.subscribe((state) => {
      if (state === "connected") {
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        void this.startSource();
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
        for (const packet of this.packetizer.packetize(payload, frame.isKeyframe)) {
          this.track.writeRtp(packet);
        }
      });
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
}

const sessions = new Map<string, Set<ScreenWebRtcSession>>();

export async function answerScreenWebRtc(
  device: string,
  offer: RTCSessionDescriptionInit,
  source: ScreenAvccSource,
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
  });
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
