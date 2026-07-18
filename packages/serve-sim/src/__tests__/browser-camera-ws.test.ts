import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

const PORT = 3462;
const TOKEN = "browser-camera-token";
const DEVICE = "12345678-1234-1234-1234-123456789ABC";

let server: PreviewServer;
const packets: Buffer[] = [];
let packetSinkDelayMs = 0;

beforeAll(async () => {
  const middleware = simMiddleware({
    basePath: "/",
    execToken: TOKEN,
    device: DEVICE,
    browserCameraPacketSink: async (_device, packet) => {
      expect(_device).toBe(DEVICE);
      if (packetSinkDelayMs > 0) await Bun.sleep(packetSinkDelayMs);
      packets.push(packet);
    },
  });
  server = await servePreview({ port: PORT, middleware, host: "127.0.0.1" });
});

afterAll(() => {
  server?.stop(true);
});

function connect(token: string): Promise<{
  socket: WebSocket;
  ready: Promise<void>;
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${PORT}/helper/${DEVICE}/camera/browser`,
    );
    let closeResolve: () => void;
    const closed = new Promise<void>((done) => { closeResolve = done; });
    let readyResolve: () => void;
    let readyReject: (error: Error) => void;
    const ready = new Promise<void>((done, fail) => {
      readyResolve = done;
      readyReject = fail;
    });
    const timeout = setTimeout(() => reject(new Error("connect timeout")), 5_000);
    socket.onopen = () => {
      clearTimeout(timeout);
      socket.send(JSON.stringify({ token }));
      resolve({ socket, ready, closed });
    };
    socket.onmessage = (event) => {
      const parse = async () => {
        const value = typeof event.data === "string"
          ? event.data
          : event.data instanceof Blob
            ? await event.data.text()
            : new TextDecoder().decode(event.data as ArrayBuffer);
        const reply = JSON.parse(value) as { ready?: boolean; error?: string };
        if (reply.error) readyReject(new Error(reply.error));
        else if (reply.ready) readyResolve();
      };
      void parse();
    };
    socket.onerror = () => reject(new Error("socket error"));
    socket.onclose = () => closeResolve();
  });
}

describe("browser camera WebSocket", () => {
  test("authenticates and forwards H.264 configuration and frames to the selected device", async () => {
    packets.length = 0;
    packetSinkDelayMs = 0;
    const channel = await connect(TOKEN);
    await channel.ready;
    const config = Buffer.from([1, 1, 100, 0, 31]);
    const frame = Buffer.from([2, 1, 0, 0, 0, 1]);
    channel.socket.send(config);
    channel.socket.send(frame);

    const deadline = Date.now() + 2_000;
    while (packets.length < 2 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(packets).toEqual([config, frame]);
    channel.socket.close();
  });

  test("preserves the keyframe and ordered deltas while decoder configuration is in flight", async () => {
    packets.length = 0;
    packetSinkDelayMs = 30;
    const channel = await connect(TOKEN);
    await channel.ready;
    const config = Buffer.from([1, 1, 100, 0, 31]);
    const key = Buffer.from([2, 1, 10]);
    const delta1 = Buffer.from([2, 0, 11]);
    const delta2 = Buffer.from([2, 0, 12]);
    channel.socket.send(config);
    channel.socket.send(key);
    channel.socket.send(delta1);
    channel.socket.send(delta2);

    const deadline = Date.now() + 2_000;
    while (packets.length < 4 && Date.now() < deadline) await Bun.sleep(10);
    expect(packets).toEqual([config, key, delta1, delta2]);
    packetSinkDelayMs = 0;
    channel.socket.close();
  });

  test("drops an overloaded frame chain and resumes in order from the next keyframe", async () => {
    packets.length = 0;
    packetSinkDelayMs = 50;
    const channel = await connect(TOKEN);
    await channel.ready;
    const config = Buffer.from([1, 1, 100, 0, 31]);
    const staleKey = Buffer.from([2, 1, 20]);
    const recoveryKey = Buffer.from([2, 1, 40]);
    const recoveryDelta1 = Buffer.from([2, 0, 41]);
    const recoveryDelta2 = Buffer.from([2, 0, 42]);
    channel.socket.send(config);
    channel.socket.send(staleKey);
    for (let index = 0; index < 9; index += 1) {
      channel.socket.send(Buffer.from([2, 0, 21 + index]));
    }
    channel.socket.send(Buffer.from([2, 0, 39]));
    channel.socket.send(recoveryKey);
    channel.socket.send(recoveryDelta1);
    channel.socket.send(recoveryDelta2);

    const deadline = Date.now() + 2_000;
    while (packets.length < 4 && Date.now() < deadline) await Bun.sleep(10);
    expect(packets).toEqual([config, recoveryKey, recoveryDelta1, recoveryDelta2]);
    packetSinkDelayMs = 0;
    channel.socket.close();
  });

  test("prioritizes a new decoder configuration ahead of frames from the old configuration", async () => {
    packets.length = 0;
    packetSinkDelayMs = 40;
    const channel = await connect(TOKEN);
    await channel.ready;
    const oldConfig = Buffer.from([1, 1, 100, 0, 31]);
    const oldKey = Buffer.from([2, 1, 50]);
    const oldDelta = Buffer.from([2, 0, 51]);
    const newConfig = Buffer.from([1, 1, 100, 0, 32]);
    const newKey = Buffer.from([2, 1, 60]);
    const newDelta = Buffer.from([2, 0, 61]);
    channel.socket.send(oldConfig);
    channel.socket.send(oldKey);
    channel.socket.send(oldDelta);
    channel.socket.send(newConfig);
    channel.socket.send(newKey);
    channel.socket.send(newDelta);

    const deadline = Date.now() + 2_000;
    while (packets.length < 4 && Date.now() < deadline) await Bun.sleep(10);
    expect(packets).toEqual([oldConfig, newConfig, newKey, newDelta]);
    packetSinkDelayMs = 0;
    channel.socket.close();
  });

  test("rejects a bad token", async () => {
    const channel = await connect("wrong-token");
    await channel.closed;
  });
});
