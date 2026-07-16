/**
 * Fallback latch for the AVCC (H.264) video path.
 *
 * The client commits to AVCC whenever the *browser* can decode H.264
 * (WebCodecs). But the *server* may not actually serve `/stream.avcc`: a
 * device started from the UI is spawned via `bunx serve-sim --detach`, which
 * runs the published `serve-sim` — older versions predate H.264 and 404 the
 * endpoint. Cross-origin that 404 is opaque to `fetch`, so the only reliable
 * signal is "no decoded frame ever arrived." This reducer drives a one-shot
 * timeout: if AVCC produces no decoded frame within the window, we fall back
 * to MJPEG (which every helper serves) and stay there for the session. The JPEG
 * seed is only a placeholder and deliberately does not prove H.264 is healthy.
 *
 * Pure and framework-free so the transition logic is unit-testable; the timer
 * and `dispatch` live in the component.
 */
export interface AvccFallbackState {
  /** True once AVCC has yielded a frame for the current stream. */
  streamed: boolean;
  /** True once we've given up on AVCC and switched to MJPEG. */
  fellBack: boolean;
}

export type AvccFallbackEvent =
  /** A frame was decoded from the H.264 stream. */
  | "decoded-frame"
  /** The startup window elapsed; fall back unless a frame already arrived. */
  | "timeout"
  /**
   * The WebCodecs decoder failed fatally mid-stream. Unlike `timeout`, this
   * downgrades even after AVCC was working — hardware H.264 decode is no longer
   * viable (e.g. a screen recorder is starving VideoToolbox), so retrying it
   * just loops.
   */
  | "error"
  /** H.264 decoded frames previously, but the stream stopped advancing. */
  | "stalled"
  /** Target stream changed (device switch / reconnect) — re-arm AVCC. */
  | "reset";

export const initialAvccFallback: AvccFallbackState = {
  streamed: false,
  fellBack: false,
};

export function avccFallbackReducer(
  state: AvccFallbackState,
  event: AvccFallbackEvent,
): AvccFallbackState {
  switch (event) {
    case "decoded-frame":
      return state.streamed ? state : { ...state, streamed: true };
    case "timeout":
      return state.streamed || state.fellBack
        ? state
        : { ...state, fellBack: true };
    case "error":
    case "stalled":
      return state.fellBack ? state : { ...state, fellBack: true };
    case "reset":
      return initialAvccFallback;
  }
}

/**
 * Startup window before giving up on AVCC and falling back to MJPEG. Long
 * enough for the first decoded keyframe to arrive, short enough that a dead
 * AVCC endpoint doesn't strand the preview on "Connecting…".
 */
export const AVCC_FRAME_TIMEOUT_MS = 4000;
