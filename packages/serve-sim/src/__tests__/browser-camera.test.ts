import { describe, expect, test } from "bun:test";
import {
  browserCameraVideoConstraints,
  browserCameraSocketUrl,
  browserVideoDevices,
  startBrowserCameraFrameLoop,
} from "../client/utils/browser-camera";

describe("browserCameraVideoConstraints", () => {
  test("asks the browser for the stream size and rate sent to the simulator", () => {
    expect(browserCameraVideoConstraints("front")).toEqual({
      deviceId: { exact: "front" },
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30, max: 30 },
    });
  });
});

describe("browserVideoDevices", () => {
  test("keeps only browser video inputs and supplies labels before permission", () => {
    expect(browserVideoDevices([
      { deviceId: "mic", kind: "audioinput", label: "Microphone" },
      { deviceId: "front", kind: "videoinput", label: "FaceTime Camera" },
      { deviceId: "usb", kind: "videoinput", label: "" },
    ])).toEqual([
      { id: "front", name: "FaceTime Camera" },
      { id: "usb", name: "Browser camera 2" },
    ]);
  });
});

describe("browserCameraSocketUrl", () => {
  test("uses secure WebSockets from an HTTPS viewer", () => {
    expect(browserCameraSocketUrl(
      "/helper/DEVICE-A/camera/browser",
      "https://simulators.example.test/simulators/1",
    )).toBe("wss://simulators.example.test/helper/DEVICE-A/camera/browser");
  });

  test("preserves a mounted relative endpoint", () => {
    expect(browserCameraSocketUrl(
      "./helper/DEVICE-A/camera/browser",
      "http://localhost:3200/preview/",
    )).toBe("ws://localhost:3200/preview/helper/DEVICE-A/camera/browser");
  });
});

describe("startBrowserCameraFrameLoop", () => {
  test("uses presented video frames, caps them at 30 fps, and cancels cleanly", () => {
    let nextId = 0;
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    const video = {
      requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancelVideoFrameCallback(id: number) {
        callbacks.delete(id);
      },
    } as Pick<HTMLVideoElement, "requestVideoFrameCallback" | "cancelVideoFrameCallback">;
    const frames: number[] = [];
    const stop = startBrowserCameraFrameLoop(video, () => frames.push(frames.length));
    const present = (now: number) => {
      const [id, callback] = callbacks.entries().next().value as [number, VideoFrameRequestCallback];
      callbacks.delete(id);
      callback(now, {} as VideoFrameCallbackMetadata);
    };

    present(0);
    present(10);
    present(34);
    expect(frames).toEqual([0, 1]);
    expect(callbacks.size).toBe(1);

    stop();
    expect(callbacks.size).toBe(0);
  });
});
