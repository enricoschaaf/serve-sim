import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
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
  test("negotiates data channels, forwards frames, and requests loss recovery", async () => {
    packets.length = 0;
    const peer = new RTCPeerConnection({
      iceServers: [],
      iceAdditionalHostAddresses: ["127.0.0.1"],
      maxMessageSize: 2 * 1024 * 1024,
    });
    const control = peer.createDataChannel("camera-control", { ordered: true });
    const frames = peer.createDataChannel("camera-frames", { ordered: false, maxRetransmits: 0 });
    const controls: Array<{ keyFrameRequired?: boolean }> = [];
    control.onMessage.subscribe((message) => {
      try { controls.push(JSON.parse(message.toString()) as { keyFrameRequired?: boolean }); } catch {}
    });

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
    await Promise.all([waitForOpen(control), waitForOpen(frames)]);

    control.send(Buffer.from([1, 1, 100, 0, 31]));
    frames.send(Buffer.from([2, 1, 0, 0, 0, 0, 10]));
    frames.send(Buffer.from([2, 0, 0, 0, 0, 2, 12]));
    await waitFor(() => packets.length >= 1 && controls.some((value) => value.keyFrameRequired));

    expect(packets).toContainEqual(Buffer.from([1, 1, 100, 0, 31]));
    expect(controls).toContainEqual({ keyFrameRequired: true });
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
