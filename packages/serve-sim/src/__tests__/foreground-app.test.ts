import { describe, expect, test } from "bun:test";
import {
  isUserFacingBundle,
  parseForegroundAppLogMessage,
} from "../foreground-app";

describe("foreground app detection", () => {
  test("reads FrontBoard visibility events", () => {
    expect(parseForegroundAppLogMessage(
      "[app<com.green-got.dev>:48249] Setting process visibility to: Foreground",
    )).toEqual({ bundleId: "com.green-got.dev", pid: 48249 });
  });

  test("reads iOS 18 front-display events", () => {
    expect(parseForegroundAppLogMessage(
      "Front display did change: <SBApplication: 0x600003d2e940; com.green-got.dev>",
    )).toEqual({ bundleId: "com.green-got.dev" });
  });

  test("excludes the XCTest runner from visible applications", () => {
    expect(isUserFacingBundle("com.greengot.servesim.runner.uitests.xctrunner")).toBe(false);
    expect(isUserFacingBundle("com.green-got.dev")).toBe(true);
  });
});
