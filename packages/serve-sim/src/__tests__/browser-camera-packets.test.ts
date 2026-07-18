import { describe, expect, test } from "bun:test";
import {
  BrowserCameraPacketQueue,
  browserCameraFrameSequence,
  browserCameraHelperPacket,
} from "../browser-camera-packets";

function frame(key: boolean, sequence: number, value: number): Buffer {
  const packet = Buffer.alloc(7);
  packet[0] = 2;
  packet[1] = key ? 1 : 0;
  packet.writeUInt32BE(sequence >>> 0, 2);
  packet[6] = value;
  return packet;
}

async function settle(): Promise<void> {
  await Bun.sleep(5);
}

describe("browser camera packets", () => {
  test("carries a frame sequence without exposing it to the native helper", () => {
    const packet = frame(true, 0x01020304, 9);
    expect(browserCameraFrameSequence(packet)).toBe(0x01020304);
    expect(browserCameraHelperPacket(packet)).toEqual(Buffer.from([2, 1, 9]));
  });

  test("requests a keyframe after an unreliable-channel sequence gap", async () => {
    const packets: Buffer[] = [];
    const controls: object[] = [];
    const queue = new BrowserCameraPacketQueue(
      "DEVICE",
      async (_device, packet) => { packets.push(packet); },
      (value) => controls.push(value),
    );
    queue.receive(Buffer.from([1, 1, 100, 0, 31]));
    queue.receive(frame(true, 0, 10));
    queue.receive(frame(false, 2, 12));
    await settle();

    expect(packets).toEqual([Buffer.from([1, 1, 100, 0, 31])]);
    expect(controls).toContainEqual({ keyFrameRequired: true });
  });

  test("recovers when an unordered keyframe arrives before its configuration", async () => {
    const packets: Buffer[] = [];
    const controls: object[] = [];
    const queue = new BrowserCameraPacketQueue(
      "DEVICE",
      async (_device, packet) => { packets.push(packet); },
      (value) => controls.push(value),
    );
    queue.receive(frame(true, 0, 10));
    queue.receive(Buffer.from([1, 1, 100, 0, 31]));
    queue.receive(frame(true, 1, 11));
    await settle();

    expect(packets).toEqual([
      Buffer.from([1, 1, 100, 0, 31]),
      Buffer.from([2, 1, 11]),
    ]);
    expect(controls).toContainEqual({ keyFrameRequired: true });
  });
});
