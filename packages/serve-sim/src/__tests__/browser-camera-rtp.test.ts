import { describe, expect, test } from "bun:test";
import { RtpHeader, RtpPacket } from "werift";
import {
  BrowserCameraMediaPump,
  BrowserCameraRtpAssembler,
  type BrowserCameraEncodedFrame,
} from "../browser-camera-rtp";

function packet(
  sequenceNumber: number,
  timestamp: number,
  marker: boolean,
  payload: Buffer,
): RtpPacket {
  return new RtpPacket(new RtpHeader({ sequenceNumber, timestamp, marker }), payload);
}

const SPS = Buffer.from([0x67, 0x42, 0xe0, 0x1f, 0xaa]);
const PPS = Buffer.from([0x68, 0xce, 0x06, 0xe2]);

describe("browser camera RTP assembler", () => {
  test("turns STAP-A configuration and an IDR into one AVCC frame", () => {
    const assembler = new BrowserCameraRtpAssembler();
    const idr = Buffer.from([0x65, 1, 2, 3]);
    const stap = Buffer.concat([
      Buffer.from([0x78, 0, SPS.length]), SPS,
      Buffer.from([0, PPS.length]), PPS,
    ]);
    expect(assembler.push(packet(1, 90_000, false, stap)).frame).toBeNull();
    const result = assembler.push(packet(2, 90_000, true, idr));
    expect(result.packetLost).toBe(false);
    expect(result.frame?.keyframe).toBe(true);
    expect(result.frame?.configuration?.subarray(0, 6)).toEqual(
      Buffer.from([1, 0x42, 0xe0, 0x1f, 0xff, 0xe1]),
    );
    expect(result.frame?.avcc).toEqual(Buffer.from([0, 0, 0, idr.length, ...idr]));
  });

  test("reassembles FU-A and reports sequence loss", () => {
    const assembler = new BrowserCameraRtpAssembler();
    const start = packet(10, 100, false, Buffer.from([0x7c, 0x85, 1, 2]));
    const end = packet(11, 100, true, Buffer.from([0x7c, 0x45, 3, 4]));
    assembler.push(start);
    expect(assembler.push(end).frame?.avcc).toEqual(
      Buffer.from([0, 0, 0, 5, 0x65, 1, 2, 3, 4]),
    );

    assembler.push(packet(20, 200, false, Buffer.from([0x7c, 0x85, 1])));
    const lost = assembler.push(packet(22, 200, true, Buffer.from([0x7c, 0x45, 2])));
    expect(lost).toEqual({ frame: null, packetLost: true });
  });
});

function frame(receivedAt: number, keyframe = true): BrowserCameraEncodedFrame {
  return {
    avcc: Buffer.from([0, 0, 0, 2, keyframe ? 0x65 : 0x41, 1]),
    configuration: keyframe ? Buffer.from([1, 0x42, 0xe0, 0x1f]) : null,
    keyframe,
    receivedAt,
    rtpTimestamp: 90_000,
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe("browser camera media pump", () => {
  test("delivers configuration before a fresh frame without per-frame acknowledgements", async () => {
    const packets: Buffer[] = [];
    const pump = new BrowserCameraMediaPump(
      "DEVICE",
      async (_device, payload) => { packets.push(payload); },
      () => {},
      () => 100,
    );
    pump.receive(frame(90));
    await waitFor(() => packets.length === 2);
    expect(packets.map((value) => value[0])).toEqual([1, 2]);
    expect(pump.stats()).toEqual({
      deliveredFrames: 1,
      droppedFrames: 0,
      lastDeliveryDelayMs: 10,
    });
  });

  test("drops stale work and requests a new keyframe", async () => {
    let keyframes = 0;
    const packets: Buffer[] = [];
    const pump = new BrowserCameraMediaPump(
      "DEVICE",
      async (_device, payload) => { packets.push(payload); },
      () => { keyframes++; },
      () => 500,
    );
    pump.receive(frame(0));
    await waitFor(() => keyframes === 1);
    expect(packets.map((value) => value[0])).toEqual([1]);
    expect(keyframes).toBe(1);
    expect(pump.stats().droppedFrames).toBe(1);
  });
});
