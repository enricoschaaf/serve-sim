import type { RtpPacket } from "werift";

const CONFIGURATION_PACKET = 1;
const FRAME_PACKET = 2;
const MAX_PENDING_FRAMES = 2;
const MAX_FRAME_AGE_MS = 200;

export type BrowserCameraEncodedFrame = {
  avcc: Buffer;
  configuration: Buffer | null;
  keyframe: boolean;
  receivedAt: number;
  rtpTimestamp: number;
};

export type BrowserCameraRtpResult = {
  frame: BrowserCameraEncodedFrame | null;
  packetLost: boolean;
};

function avcc(nalus: readonly Buffer[]): Buffer {
  const output = Buffer.allocUnsafe(nalus.reduce((size, nalu) => size + 4 + nalu.length, 0));
  let offset = 0;
  for (const nalu of nalus) {
    output.writeUInt32BE(nalu.length, offset);
    offset += 4;
    nalu.copy(output, offset);
    offset += nalu.length;
  }
  return output;
}

function avcC(sps: Buffer, pps: Buffer): Buffer {
  if (sps.length < 4) throw new Error("Invalid H.264 SPS");
  return Buffer.from([
    1,
    sps[1]!,
    sps[2]!,
    sps[3]!,
    0xff,
    0xe1,
    (sps.length >> 8) & 0xff,
    sps.length & 0xff,
    ...sps,
    1,
    (pps.length >> 8) & 0xff,
    pps.length & 0xff,
    ...pps,
  ]);
}

function sequenceAfter(sequence: number): number {
  return (sequence + 1) & 0xffff;
}

/** Reassembles RFC 6184 single-NAL, STAP-A, and FU-A RTP payloads into AVCC frames. */
export class BrowserCameraRtpAssembler {
  private timestamp: number | null = null;
  private lastSequence: number | null = null;
  private nalus: Buffer[] = [];
  private fragment: Buffer[] | null = null;
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private configurationFingerprint = "";

  push(packet: RtpPacket, receivedAt = performance.now()): BrowserCameraRtpResult {
    let packetLost = false;
    const { sequenceNumber, timestamp, marker } = packet.header;
    if (this.lastSequence !== null && sequenceNumber !== sequenceAfter(this.lastSequence)) {
      packetLost = true;
      this.resetFrame();
    }
    this.lastSequence = sequenceNumber;
    if (this.timestamp !== null && timestamp !== this.timestamp && this.nalus.length > 0) {
      packetLost = true;
      this.resetFrame();
    }
    this.timestamp = timestamp;

    if (!this.consumePayload(packet.payload)) {
      this.resetFrame();
      return { frame: null, packetLost: true };
    }
    if (!marker) return { frame: null, packetLost };

    if (this.fragment) {
      this.resetFrame();
      return { frame: null, packetLost: true };
    }
    const nalus = this.nalus;
    this.nalus = [];
    this.timestamp = null;
    for (const nalu of nalus) {
      const type = nalu[0]! & 0x1f;
      if (type === 7) this.sps = Buffer.from(nalu);
      else if (type === 8) this.pps = Buffer.from(nalu);
    }
    const videoNalus = nalus.filter((nalu) => {
      const type = nalu[0]! & 0x1f;
      return type !== 7 && type !== 8;
    });
    if (videoNalus.length === 0) return { frame: null, packetLost };

    let configuration: Buffer | null = null;
    if (this.sps && this.pps) {
      const next = avcC(this.sps, this.pps);
      const fingerprint = next.toString("base64");
      if (fingerprint !== this.configurationFingerprint) {
        this.configurationFingerprint = fingerprint;
        configuration = next;
      }
    }
    const keyframe = videoNalus.some((nalu) => (nalu[0]! & 0x1f) === 5);
    return {
      frame: {
        avcc: avcc(videoNalus),
        configuration,
        keyframe,
        receivedAt,
        rtpTimestamp: timestamp,
      },
      packetLost,
    };
  }

  private consumePayload(payload: Buffer): boolean {
    if (payload.length < 1) return false;
    const type = payload[0]! & 0x1f;
    if (type > 0 && type < 24) {
      this.nalus.push(payload);
      return true;
    }
    if (type === 24) {
      let offset = 1;
      while (offset < payload.length) {
        if (offset + 2 > payload.length) return false;
        const length = payload.readUInt16BE(offset);
        offset += 2;
        if (length === 0 || offset + length > payload.length) return false;
        this.nalus.push(payload.subarray(offset, offset + length));
        offset += length;
      }
      return true;
    }
    if (type !== 28 || payload.length < 3) return false;
    const fragmentHeader = payload[1]!;
    const start = (fragmentHeader & 0x80) !== 0;
    const end = (fragmentHeader & 0x40) !== 0;
    if (start) {
      const naluHeader = (payload[0]! & 0xe0) | (fragmentHeader & 0x1f);
      this.fragment = [Buffer.from([naluHeader]), payload.subarray(2)];
    } else if (this.fragment) {
      this.fragment.push(payload.subarray(2));
    } else {
      return false;
    }
    if (end && this.fragment) {
      this.nalus.push(Buffer.concat(this.fragment));
      this.fragment = null;
    }
    return true;
  }

  private resetFrame(): void {
    this.timestamp = null;
    this.nalus = [];
    this.fragment = null;
  }
}

export type BrowserCameraMediaPumpStats = {
  deliveredFrames: number;
  droppedFrames: number;
  lastDeliveryDelayMs: number;
};

/** Keeps camera delivery live by bounding local work and preferring a fresh keyframe after loss. */
export class BrowserCameraMediaPump {
  private pendingConfiguration: Buffer | null = null;
  private frames: BrowserCameraEncodedFrame[] = [];
  private processing = false;
  private closed = false;
  private waitingForKeyframe = true;
  private deliveredFrames = 0;
  private droppedFrames = 0;
  private lastDeliveryDelayMs = 0;

  constructor(
    private readonly device: string,
    private readonly sink: (device: string, packet: Buffer) => Promise<void>,
    private readonly requestKeyframe: () => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  receive(frame: BrowserCameraEncodedFrame): void {
    if (this.closed) return;
    if (frame.configuration) this.pendingConfiguration = frame.configuration;
    if (this.waitingForKeyframe && !frame.keyframe) return;
    if (frame.keyframe) this.waitingForKeyframe = false;
    if (this.frames.length >= MAX_PENDING_FRAMES) {
      this.droppedFrames += this.frames.length + 1;
      this.frames = [];
      this.waitingForKeyframe = true;
      this.requestKeyframe();
      return;
    }
    this.frames.push(frame);
    this.drain();
  }

  requestRecovery(): void {
    if (this.closed) return;
    this.frames = this.frames.filter((frame) => frame.keyframe);
    this.waitingForKeyframe = true;
    this.requestKeyframe();
  }

  stats(): BrowserCameraMediaPumpStats {
    return {
      deliveredFrames: this.deliveredFrames,
      droppedFrames: this.droppedFrames,
      lastDeliveryDelayMs: this.lastDeliveryDelayMs,
    };
  }

  close(): void {
    this.closed = true;
    this.pendingConfiguration = null;
    this.frames = [];
  }

  private drain(): void {
    if (this.closed || this.processing) return;
    const configuration = this.pendingConfiguration;
    const frame = configuration ? undefined : this.frames.shift();
    if (!configuration && !frame) return;
    if (configuration) this.pendingConfiguration = null;
    if (frame && this.now() - frame.receivedAt > MAX_FRAME_AGE_MS) {
      this.droppedFrames++;
      this.waitingForKeyframe = true;
      this.requestKeyframe();
      this.drain();
      return;
    }
    const packet = configuration
      ? Buffer.concat([Buffer.from([CONFIGURATION_PACKET]), configuration])
      : Buffer.concat([Buffer.from([FRAME_PACKET, frame!.keyframe ? 1 : 0]), frame!.avcc]);
    this.processing = true;
    void this.sink(this.device, packet)
      .then(() => {
        if (frame) {
          this.deliveredFrames++;
          this.lastDeliveryDelayMs = this.now() - frame.receivedAt;
        }
      })
      .catch(() => {
        if (frame) this.droppedFrames++;
        this.frames = [];
        this.waitingForKeyframe = true;
        this.requestKeyframe();
      })
      .finally(() => {
        this.processing = false;
        this.drain();
      });
  }
}
