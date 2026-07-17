import { describe, expect, test } from "bun:test";
import {
  browserCameraSocketUrl,
  browserVideoDevices,
} from "../client/utils/browser-camera";

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
