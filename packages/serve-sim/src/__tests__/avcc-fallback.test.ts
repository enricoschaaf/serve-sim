import { describe, expect, test } from "bun:test";
import {
  avccFallbackReducer,
  initialAvccFallback,
  type AvccFallbackState,
} from "../client/avcc-fallback";

/** Apply a sequence of events from the initial state. */
function run(events: Parameters<typeof avccFallbackReducer>[1][]): AvccFallbackState {
  return events.reduce(avccFallbackReducer, initialAvccFallback);
}

describe("avccFallbackReducer", () => {
  test("starts on AVCC (no fallback) until told otherwise", () => {
    expect(initialAvccFallback).toEqual({ streamed: false, fellBack: false });
  });

  test("timeout without a frame falls back to MJPEG", () => {
    // The repro: helper has no /stream.avcc route, so no frame ever arrives.
    expect(run(["timeout"]).fellBack).toBe(true);
  });

  test("a decoded frame before timeout keeps AVCC", () => {
    const state = run(["decoded-frame", "timeout"]);
    expect(state.streamed).toBe(true);
    expect(state.fellBack).toBe(false);
  });

  test("a stalled stream downgrades after decoded frames arrived", () => {
    expect(run(["decoded-frame", "stalled"]).fellBack).toBe(true);
  });

  test("error downgrades a working stream where timeout does not", () => {
    expect(run(["decoded-frame", "timeout"]).fellBack).toBe(false);
    expect(run(["decoded-frame", "error"]).fellBack).toBe(true);
  });

  test("reset re-arms AVCC after a device switch / reconnect", () => {
    const fellBack = run(["timeout"]);
    expect(fellBack.fellBack).toBe(true);
    expect(avccFallbackReducer(fellBack, "reset")).toEqual(initialAvccFallback);
  });

  test("once fallen back, further timeouts are idempotent", () => {
    const once = run(["timeout"]);
    expect(avccFallbackReducer(once, "timeout")).toEqual(once);
  });
});
