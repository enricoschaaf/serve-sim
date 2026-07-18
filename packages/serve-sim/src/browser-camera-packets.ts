export const MAX_BROWSER_CAMERA_PACKET_BYTES = 2 * 1024 * 1024;
export const MAX_BROWSER_CAMERA_FRAME_QUEUE = 2;

const CONFIGURATION_PACKET = 1;
const FRAME_PACKET = 2;
const FRAME_HEADER_BYTES = 6;

export type BrowserCameraPacketSink = (device: string, packet: Buffer) => Promise<void>;

export function browserCameraFrameSequence(packet: Uint8Array): number | null {
  if (packet[0] !== FRAME_PACKET || packet.length < FRAME_HEADER_BYTES) return null;
  return (
    (packet[2]! << 24)
    | (packet[3]! << 16)
    | (packet[4]! << 8)
    | packet[5]!
  ) >>> 0;
}

export function browserCameraHelperPacket(packet: Uint8Array): Buffer | null {
  if (packet[0] === CONFIGURATION_PACKET && packet.length >= 2) return Buffer.from(packet);
  if (packet[0] !== FRAME_PACKET || packet.length < FRAME_HEADER_BYTES) return null;
  const helper = Buffer.allocUnsafe(packet.length - 4);
  helper[0] = FRAME_PACKET;
  helper[1] = packet[1]!;
  helper.set(packet.subarray(FRAME_HEADER_BYTES), 2);
  return helper;
}

export class BrowserCameraPacketQueue {
  private closed = false;
  private processing = false;
  private pendingConfig: Buffer | null = null;
  private frameQueue: Buffer[] = [];
  private waitingForKeyframe = true;
  private configurationReceived = false;
  private keyframeBeforeConfiguration = false;
  private lastSequence: number | null = null;

  constructor(
    private readonly device: string,
    private readonly sink: BrowserCameraPacketSink,
    private readonly sendControl: (value: object) => void,
  ) {}

  receive(payload: Uint8Array): boolean {
    if (this.closed
        || payload.length < 2
        || payload.length > MAX_BROWSER_CAMERA_PACKET_BYTES
        || (payload[0] !== CONFIGURATION_PACKET && payload[0] !== FRAME_PACKET)) {
      return false;
    }

    if (payload[0] === CONFIGURATION_PACKET) {
      this.pendingConfig = Buffer.from(payload);
      this.frameQueue = [];
      this.waitingForKeyframe = true;
      this.configurationReceived = true;
      this.lastSequence = null;
      if (this.keyframeBeforeConfiguration) {
        this.keyframeBeforeConfiguration = false;
        this.requestKeyFrame();
      }
      this.drain();
      return true;
    }

    const sequence = browserCameraFrameSequence(payload);
    if (sequence === null) return false;
    const keyFrame = payload[1] === 1;
    if (!this.configurationReceived) {
      if (keyFrame) this.keyframeBeforeConfiguration = true;
      return true;
    }

    const expectedSequence = this.lastSequence === null
      ? sequence
      : (this.lastSequence + 1) >>> 0;
    if (!keyFrame && sequence !== expectedSequence) {
      this.frameQueue = [];
      this.requestKeyFrame();
      return true;
    }

    if (this.waitingForKeyframe) {
      if (!keyFrame) return true;
      this.waitingForKeyframe = false;
    } else if (this.frameQueue.length >= MAX_BROWSER_CAMERA_FRAME_QUEUE) {
      this.frameQueue = [];
      if (!keyFrame) {
        this.requestKeyFrame();
        return true;
      }
      this.waitingForKeyframe = false;
    }

    const helperPacket = browserCameraHelperPacket(payload);
    if (!helperPacket) return false;
    this.lastSequence = sequence;
    this.frameQueue.push(helperPacket);
    this.drain();
    return true;
  }

  close(): void {
    this.closed = true;
    this.pendingConfig = null;
    this.frameQueue = [];
  }

  private requestKeyFrame(): void {
    if (!this.waitingForKeyframe) this.waitingForKeyframe = true;
    this.sendControl({ keyFrameRequired: true });
  }

  private drain(): void {
    if (this.closed || this.processing || (!this.pendingConfig && this.frameQueue.length === 0)) {
      return;
    }
    const packet = this.pendingConfig ?? this.frameQueue.shift()!;
    if (this.pendingConfig) this.pendingConfig = null;
    this.processing = true;
    void this.sink(this.device, packet)
      .catch((error) => {
        if (packet[0] === FRAME_PACKET) {
          this.frameQueue = [];
          this.requestKeyFrame();
        }
        this.sendControl({
          error: error instanceof Error ? error.message : String(error),
          ...(packet[0] === FRAME_PACKET ? { keyFrameRequired: true } : {}),
        });
      })
      .finally(() => {
        this.processing = false;
        this.drain();
      });
  }
}
