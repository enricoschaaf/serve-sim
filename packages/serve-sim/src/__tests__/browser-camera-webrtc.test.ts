import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpReceiver,
  RtpHeader,
  RtpPacket,
  useH264,
  type RTCDataChannel,
} from "werift";
import { closeBrowserCameraWebRtc } from "../browser-camera-webrtc";
import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

const PORT = 3463;
const TOKEN = "browser-camera-webrtc-token";
const DEVICE = "12345678-1234-1234-1234-123456789ABC";

let server: PreviewServer;
const packets: Buffer[] = [];

beforeAll(async () => {
  server = await servePreview({
    port: PORT,
    host: "127.0.0.1",
    middleware: simMiddleware({
      basePath: "/",
      execToken: TOKEN,
      device: DEVICE,
      browserCameraPacketSink: async (_device, packet) => { packets.push(packet); },
    }),
  });
});

afterAll(async () => {
  await closeBrowserCameraWebRtc(DEVICE);
  server?.stop(true);
});

function waitForOpen(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("channel open timeout")), 5_000);
    channel.stateChanged.subscribe((state) => {
      if (state !== "open") return;
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

describe("browser camera WebRTC", () => {
  test("negotiates an H.264 media track, forwards frames, and requests loss recovery", async () => {
    packets.length = 0;
    const peer = new RTCPeerConnection({
      codecs: { video: [useH264()] },
      iceServers: [],
      iceAdditionalHostAddresses: ["127.0.0.1"],
      maxMessageSize: 2 * 1024 * 1024,
    });
    const control = peer.createDataChannel("camera-control", { ordered: true });
    const video = new MediaStreamTrack({ kind: "video" });
    const sender = peer.addTrack(video);
    const pli = spyOn(RTCRtpReceiver.prototype, "sendRtcpPLI");

    await peer.setLocalDescription(await peer.createOffer());
    const response = await fetch(`http://127.0.0.1:${PORT}/helper/${DEVICE}/camera/webrtc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${PORT}`,
      },
      body: JSON.stringify({ offer: peer.localDescription }),
    });
    expect(response.status).toBe(200);
    const reply = await response.json() as { answer: { type: "answer"; sdp: string } };
    await peer.setRemoteDescription(reply.answer);
    await waitForOpen(control);

    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f, 0xaa]);
    const pps = Buffer.from([0x68, 0xce, 0x06, 0xe2]);
    const write = (sequenceNumber: number, marker: boolean, payload: Buffer) => video.writeRtp(
      new RtpPacket(new RtpHeader({
        payloadType: 96,
        sequenceNumber,
        timestamp: 90_000,
        marker,
        ssrc: sender.ssrc,
      }), payload),
    );
    write(1, false, sps);
    write(2, false, pps);
    write(3, true, Buffer.from([0x65, 10]));
    await waitFor(() => packets.length >= 2);
    write(5, true, Buffer.from([0x41, 12]));
    await waitFor(() => pli.mock.calls.length > 0);

    expect(packets.map((packet) => packet[0])).toEqual([1, 2]);
    pli.mockRestore();
    await peer.close();
  }, 15_000);

  test("rejects signaling without the camera token", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/helper/${DEVICE}/camera/webrtc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offer: { type: "offer", sdp: "invalid" } }),
    });
    expect(response.status).toBe(401);
  });
});
