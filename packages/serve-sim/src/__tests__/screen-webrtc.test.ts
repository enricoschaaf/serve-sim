import { afterEach, describe, expect, test } from "bun:test";
import {
  RTCPeerConnection,
  useH264,
  type MediaStreamTrack,
  type RtpPacket,
} from "werift";
import {
  H264RtpPacketizer,
  answerScreenWebRtc,
  closeScreenWebRtc,
  parseAvccDescription,
  parseAvccNalus,
  unwrapAvccEnvelope,
  type ScreenAvccSource,
} from "../screen-webrtc";
import type { AvccFrame } from "../native";

const DEVICE = "12345678-1234-1234-1234-123456789ABC";
const SPS = Buffer.from([0x67, 0x42, 0xe0, 0x1f, 0xaa]);
const PPS = Buffer.from([0x68, 0xce, 0x06, 0xe2]);

function description(): Buffer {
  return Buffer.from([
    1, 0x42, 0xe0, 0x1f, 0xff, 0xe1,
    0, SPS.length, ...SPS,
    1, 0, PPS.length, ...PPS,
  ]);
}

function avcc(...nalus: Buffer[]): Buffer {
  return Buffer.concat(nalus.map((nalu) => {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(nalu.length);
    return Buffer.concat([length, nalu]);
  }));
}

function envelope(tag: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt32BE(payload.length + 1);
  header[4] = tag;
  return Buffer.concat([header, payload]);
}

describe("screen H.264 RTP packetizer", () => {
  test("parses native AVCC envelopes, decoder configuration, and NAL units", () => {
    expect(unwrapAvccEnvelope(envelope(1, description()))).toEqual(description());
    expect(parseAvccDescription(description())).toEqual({ lengthSize: 4, sps: [SPS], pps: [PPS] });
    const idr = Buffer.from([0x65, 1, 2, 3]);
    const delta = Buffer.from([0x41, 4, 5]);
    expect(parseAvccNalus(avcc(idr, delta), 4)).toEqual([idr, delta]);
  });

  test("prepends SPS/PPS to keyframes and marks only the final packet", () => {
    const packetizer = new H264RtpPacketizer();
    packetizer.configure(description());
    const idr = Buffer.from([0x65, 1, 2, 3]);
    const packets = packetizer.packetize(avcc(idr), true);
    expect(packets.map((packet) => packet.payload)).toEqual([SPS, PPS, idr]);
    expect(packets.map((packet) => packet.header.marker)).toEqual([false, false, true]);
    expect(packets[1]!.header.sequenceNumber).toBe((packets[0]!.header.sequenceNumber + 1) & 0xffff);
  });

  test("fragments oversized NAL units as FU-A within the RTP payload budget", () => {
    const packetizer = new H264RtpPacketizer();
    packetizer.configure(description());
    const nalu = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(3_000, 0xab)]);
    const packets = packetizer.packetize(avcc(nalu), false);
    expect(packets.length).toBe(3);
    expect(packets.every((packet) => packet.payload.length <= 1_200)).toBe(true);
    expect(packets[0]!.payload[0]! & 0x1f).toBe(28);
    expect(packets[0]!.payload[1]! & 0x80).toBe(0x80);
    expect(packets.at(-1)!.payload[1]! & 0x40).toBe(0x40);
    expect(packets.map((packet) => packet.header.marker)).toEqual([false, false, true]);
  });
});

class FakeAvccSource implements ScreenAvccSource {
  callback: ((frame: AvccFrame) => Promise<void>) | null = null;

  async subscribeAvcc(callback: (frame: AvccFrame) => Promise<void>): Promise<() => void> {
    this.callback = callback;
    return () => { this.callback = null; };
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

afterEach(async () => {
  await closeScreenWebRtc(DEVICE);
});

describe("screen WebRTC video track", () => {
  test("negotiates H.264 and forwards the native encoded stream as RTP", async () => {
    const source = new FakeAvccSource();
    const peer = new RTCPeerConnection({
      codecs: { video: [useH264()] },
      iceServers: [],
      iceAdditionalHostAddresses: ["127.0.0.1"],
    });
    const packets: RtpPacket[] = [];
    let remoteTrack: MediaStreamTrack | null = null;
    peer.onTrack.subscribe((track) => {
      remoteTrack = track;
      track.onReceiveRtp.subscribe((packet) => packets.push(packet));
    });
    peer.addTransceiver("video", { direction: "recvonly" });
    await peer.setLocalDescription(await peer.createOffer());
    const answer = await answerScreenWebRtc(DEVICE, peer.localDescription!, source);
    await peer.setRemoteDescription(answer);
    await waitFor(() => source.callback !== null && remoteTrack !== null);

    await source.callback!({
      data: envelope(1, description()),
      width: 1179,
      height: 2556,
      isDescription: true,
      isKeyframe: false,
    });
    await source.callback!({
      data: envelope(2, avcc(Buffer.from([0x65, 1, 2, 3]))),
      width: 1179,
      height: 2556,
      isDescription: false,
      isKeyframe: true,
    });
    await waitFor(() => packets.length >= 3);
    expect(packets.at(-1)!.header.marker).toBe(true);
    expect(packets.at(-1)!.header.payloadType).toBe(remoteTrack!.codec!.payloadType);
    await peer.close();
  }, 15_000);
});
