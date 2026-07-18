import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { createServer as createHttpServer } from "http";
import { createServer as createNetServer, type AddressInfo } from "net";
import { dirname } from "path";
import {
  cameraHelperBundlesFile,
  cameraHelperPidFile,
  cameraHelperSocketFile,
  closeBrowserCameraFrameStream,
  isCameraHelperAlive,
  readCameraStatus,
  sendBrowserCameraPacket,
} from "../camera-helper";
import { simMiddleware } from "../middleware";

const udid = randomUUID().toUpperCase();
const stateFiles = [
  cameraHelperPidFile(udid),
  cameraHelperBundlesFile(udid),
  cameraHelperSocketFile(udid),
];

beforeAll(() => {
  mkdirSync(dirname(cameraHelperPidFile(udid)), { recursive: true });
});

afterAll(() => {
  for (const path of stateFiles) {
    try { unlinkSync(path); } catch {}
  }
});

async function withMiddlewareServer<T>(fn: (origin: string) => Promise<T>): Promise<T> {
  const middleware = simMiddleware({ basePath: "/", proxyHelpers: true });
  const server = createHttpServer((req, res) => {
    void middleware(req, res, async () => {
      res.writeHead(404);
      res.end("Not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe("camera status", () => {
  test("reuses one binary helper stream for browser camera frames", async () => {
    const socketPath = cameraHelperSocketFile(udid);
    try { unlinkSync(socketPath); } catch {}
    let connections = 0;
    const frames: Buffer[] = [];
    const server = createNetServer((socket) => {
      connections++;
      let buffer = Buffer.alloc(0);
      let streaming = false;
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (!streaming) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) return;
          expect(JSON.parse(buffer.subarray(0, newline).toString("utf8"))).toEqual({
            action: "h264Stream",
          });
          buffer = buffer.subarray(newline + 1);
          streaming = true;
          socket.write('{"ok":true,"stream":true}\n');
        }
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(0);
          if (buffer.length < 4 + length) return;
          frames.push(Buffer.from(buffer.subarray(4, 4 + length)));
          buffer = buffer.subarray(4 + length);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      await sendBrowserCameraPacket(udid, Buffer.from([1, 1, 100, 0, 31]));
      await sendBrowserCameraPacket(udid, Buffer.from([2, 1, 0, 0, 0, 1]));
      await waitFor(() => frames.length === 2);
      expect(connections).toBe(1);
      expect(frames).toEqual([
        Buffer.from([1, 1, 100, 0, 31]),
        Buffer.from([2, 1, 0, 0, 0, 1]),
      ]);
    } finally {
      closeBrowserCameraFrameStream(udid);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("replays the decoder configuration after the helper stream reconnects", async () => {
    const socketPath = cameraHelperSocketFile(udid);
    try { unlinkSync(socketPath); } catch {}
    let connections = 0;
    const packets: Buffer[][] = [];
    const server = createNetServer((socket) => {
      const connection = connections++;
      packets[connection] = [];
      let buffer = Buffer.alloc(0);
      let streaming = false;
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (!streaming) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) return;
          buffer = buffer.subarray(newline + 1);
          streaming = true;
          socket.write('{"ok":true,"stream":true}\n');
        }
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(0);
          if (buffer.length < 4 + length) return;
          packets[connection]!.push(Buffer.from(buffer.subarray(4, 4 + length)));
          buffer = buffer.subarray(4 + length);
          if (connection === 0) setTimeout(() => socket.destroy(), 0);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const configuration = Buffer.from([1, 1, 100, 0, 31]);
    const frame = Buffer.from([2, 1, 0, 0, 0, 1]);
    try {
      await sendBrowserCameraPacket(udid, configuration);
      await waitFor(() => packets[0]?.length === 1);
      await Bun.sleep(20);
      await sendBrowserCameraPacket(udid, frame);
      await waitFor(() => connections === 2 && packets[1]?.length === 2);
      expect(connections).toBe(2);
      expect(packets).toEqual([
        [configuration],
        [configuration, frame],
      ]);
    } finally {
      closeBrowserCameraFrameStream(udid);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("treats a malformed pid file as a stopped helper", async () => {
    writeFileSync(cameraHelperPidFile(udid), "not-a-pid");

    expect(isCameraHelperAlive(udid)).toBe(false);
    expect(await readCameraStatus(udid)).toEqual({ udid, alive: false });
  });

  test("decodes split UTF-8, validates bundles, and keeps helper extensions", async () => {
    const socketPath = cameraHelperSocketFile(udid);
    try { unlinkSync(socketPath); } catch {}
    const reply = Buffer.from(JSON.stringify({
      ok: true,
      source: "video",
      arg: "/tmp/zażółć.mov",
      alive: false,
      udid: "wrong-device",
      helperPid: 0,
      bundleIds: ["wrong.bundle"],
      frameCount: 12,
    }) + "\n");
    const split = reply.indexOf(Buffer.from("ż")) + 1;
    const server = createNetServer((socket) => {
      socket.once("data", () => {
        socket.write(reply.subarray(0, split));
        socket.end(reply.subarray(split));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    writeFileSync(cameraHelperPidFile(udid), String(process.pid));
    writeFileSync(cameraHelperBundlesFile(udid), JSON.stringify({
      helperPid: process.pid,
      bundleIds: ["com.example.app", 42],
    }));

    try {
      expect(await readCameraStatus(udid)).toEqual({
        udid,
        alive: true,
        helperPid: process.pid,
        bundleIds: ["com.example.app"],
        ok: true,
        source: "video",
        arg: "/tmp/zażółć.mov",
        frameCount: 12,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("serves status without opening a simulator session", async () => {
    try { unlinkSync(cameraHelperPidFile(udid)); } catch {}
    await withMiddlewareServer(async (origin) => {
      const response = await fetch(`${origin}/helper/${udid}/camera/status`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ udid, alive: false });
    });
  });

  test("rejects writes and malformed device IDs", async () => {
    await withMiddlewareServer(async (origin) => {
      const writeResponse = await fetch(`${origin}/helper/${udid}/camera/status`, {
        method: "POST",
      });
      expect(writeResponse.status).toBe(405);
      expect(writeResponse.headers.get("allow")).toBe("GET");

      const invalidResponse = await fetch(`${origin}/helper/not-a-udid/camera/status`);
      expect(invalidResponse.status).toBe(400);
      expect(await invalidResponse.json()).toEqual({ error: "invalid_device" });
    });
  });
});
