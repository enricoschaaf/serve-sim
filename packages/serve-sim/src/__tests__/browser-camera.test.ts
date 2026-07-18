import { describe, expect, test } from "bun:test";
import {
  browserCameraBitrate,
  browserCameraCanEncodeVideoDirectly,
  browserCameraEncoderConfigs,
  browserCameraVideoConstraints,
  browserCameraH264ConfigPacket,
  browserCameraH264FramePacket,
  browserCameraFrameLayout,
  browserCameraSocketUrl,
  browserVideoDevices,
  startBrowserCameraFrameLoop,
} from "../client/utils/browser-camera";

describe("browser camera H.264 packets", () => {
  test("keeps decoder configuration distinct from encoded frames", () => {
    expect([...new Uint8Array(browserCameraH264ConfigPacket(new Uint8Array([1, 100, 0, 31])))])
      .toEqual([1, 1, 100, 0, 31]);
    const chunk = {
      type: "key",
      byteLength: 4,
      copyTo(target: AllowSharedBufferSource) {
        const view = ArrayBuffer.isView(target)
          ? new Uint8Array(target.buffer, target.byteOffset, target.byteLength)
          : new Uint8Array(target);
        view.set([0, 0, 0, 1]);
      },
    } as EncodedVideoChunk;
    expect([...new Uint8Array(browserCameraH264FramePacket(chunk))]).toEqual([2, 1, 0, 0, 0, 1]);
  });
});

describe("browserCameraVideoConstraints", () => {
  test("asks the browser for the stream size and rate sent to the simulator", () => {
    expect(browserCameraVideoConstraints("front")).toEqual({
      deviceId: { exact: "front" },
      width: { ideal: 960 },
      height: { ideal: 720 },
      aspectRatio: { ideal: 4 / 3 },
      frameRate: { ideal: 30, max: 30 },
    });
  });
});

describe("browserCameraFrameLayout", () => {
  test("keeps a 4:3 identity webcam at native resolution", () => {
    expect(browserCameraFrameLayout(960, 720)).toEqual({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 960,
      sourceHeight: 720,
      outputWidth: 960,
      outputHeight: 720,
    });
  });

  test("keeps a lower-resolution 4:3 webcam without stretching it", () => {
    expect(browserCameraFrameLayout(640, 480)).toEqual({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 640,
      sourceHeight: 480,
      outputWidth: 640,
      outputHeight: 480,
    });
  });

  test("preserves wide input and caps output at 720p", () => {
    expect(browserCameraFrameLayout(1920, 1080)).toEqual({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 1920,
      sourceHeight: 1080,
      outputWidth: 1280,
      outputHeight: 720,
    });
  });

  test("budgets enough H.264 data per pixel for identity detail", () => {
    expect(browserCameraBitrate(640, 480)).toBe(1_800_000);
    expect(browserCameraBitrate(960, 720)).toBe(2_500_000);
    expect(browserCameraBitrate(1280, 720)).toBe(2_500_000);
    expect(browserCameraBitrate(960, 720, "detail")).toBe(3_000_000);
    expect(browserCameraBitrate(1280, 720, "detail")).toBe(3_500_000);
  });

  test("tries High profile first and falls back to broadly-supported Baseline", () => {
    expect(browserCameraEncoderConfigs(960, 720, "detail").map(({ codec }) => codec))
      .toEqual(["avc1.64001F", "avc1.42E01F"]);
    expect(browserCameraEncoderConfigs(960, 720, "balanced").map(({ codec }) => codec))
      .toEqual(["avc1.42E01F"]);
  });

  test("bypasses canvas conversion when the webcam already matches the encoder", () => {
    expect(browserCameraCanEncodeVideoDirectly(browserCameraFrameLayout(960, 720))).toBe(true);
    expect(browserCameraCanEncodeVideoDirectly(browserCameraFrameLayout(1920, 1080))).toBe(false);
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
