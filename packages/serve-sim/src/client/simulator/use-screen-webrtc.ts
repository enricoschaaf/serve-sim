import { useEffect, useRef } from "react";

export function isScreenWebRtcSupported(): boolean {
  return typeof RTCPeerConnection !== "undefined"
    && typeof RTCRtpReceiver !== "undefined"
    && typeof MediaStream !== "undefined"
    && typeof HTMLVideoElement !== "undefined"
    && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function";
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("WebRTC screen ICE gathering timed out"));
    }, 5_000);
    const onChange = () => {
      if (peer.iceGatheringState !== "complete") return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onChange);
    };
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

export function useScreenWebRtc({
  endpoint,
  token,
  enabled,
  videoRef,
  onFirstFrame,
  onFrame,
  onError,
}: {
  endpoint?: string;
  token?: string;
  enabled: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onFirstFrame?: () => void;
  onFrame?: () => void;
  onError?: (message: string) => void;
}): void {
  const callbacks = useRef({ onFirstFrame, onFrame, onError });
  callbacks.current = { onFirstFrame, onFrame, onError };

  useEffect(() => {
    if (!enabled || !endpoint || !token || !isScreenWebRtcSupported()) return;
    const peer = new RTCPeerConnection({ iceServers: [] });
    const control = peer.createDataChannel("screen-control", { ordered: true });
    const videoElement = videoRef.current;
    const transceiver = peer.addTransceiver("video", { direction: "recvonly" });
    const h264Codecs = RTCRtpReceiver.getCapabilities("video")?.codecs.filter(
      (codec) => codec.mimeType.toLowerCase() === "video/h264",
    ) ?? [];
    if (h264Codecs.length > 0) transceiver.setCodecPreferences(h264Codecs);

    let stopped = false;
    let receivedFrame = false;
    let videoFrameCallback = 0;
    let startupTimer: ReturnType<typeof setTimeout> | null = null;
    let telemetryTimer: number | null = null;
    let lastActivityAt = performance.now();
    let previousPacketsReceived = 0;
    let previousPacketsLost = 0;
    let previousFramesDropped = 0;
    const fail = (message: string) => {
      if (!stopped) callbacks.current.onError?.(message);
    };
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed") fail("WebRTC screen connection failed");
    });
    peer.addEventListener("track", (event) => {
      if (stopped || event.track.kind !== "video") return;
      const video = videoElement;
      if (!video) return;
      video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void video.play().catch((error) => fail(
        error instanceof Error ? error.message : "WebRTC screen playback failed",
      ));
      const nextFrame = () => {
        if (stopped) return;
        callbacks.current.onFrame?.();
        if (!receivedFrame) {
          receivedFrame = true;
          if (startupTimer) clearTimeout(startupTimer);
          callbacks.current.onFirstFrame?.();
        }
        videoFrameCallback = video.requestVideoFrameCallback(nextFrame);
      };
      videoFrameCallback = video.requestVideoFrameCallback(nextFrame);
    });

    const sendTelemetry = async () => {
      if (stopped || control.readyState !== "open") return;
      let packetsReceived = previousPacketsReceived;
      let packetsLost = previousPacketsLost;
      let framesDropped = previousFramesDropped;
      let roundTripTimeMs = 0;
      try {
        const report = await peer.getStats();
        report.forEach((value) => {
          if (value.type === "inbound-rtp" && value.kind === "video") {
            packetsReceived = value.packetsReceived ?? packetsReceived;
            packetsLost = value.packetsLost ?? packetsLost;
            framesDropped = value.framesDropped ?? framesDropped;
          }
          if (value.type === "candidate-pair" && value.state === "succeeded"
              && typeof value.currentRoundTripTime === "number") {
            roundTripTimeMs = Math.round(value.currentRoundTripTime * 1_000);
          }
        });
      } catch {}
      const payload = {
        viewportWidth: videoElement?.clientWidth ?? 0,
        devicePixelRatio: window.devicePixelRatio,
        visible: document.visibilityState === "visible",
        active: performance.now() - lastActivityAt < 3_000,
        packetsReceived: Math.max(0, packetsReceived - previousPacketsReceived),
        packetsLost: Math.max(0, packetsLost - previousPacketsLost),
        decoderDrops: Math.max(0, framesDropped - previousFramesDropped),
        roundTripTimeMs,
      };
      previousPacketsReceived = packetsReceived;
      previousPacketsLost = packetsLost;
      previousFramesDropped = framesDropped;
      control.send(JSON.stringify(payload));
    };
    const markActive = () => {
      lastActivityAt = performance.now();
      void sendTelemetry();
    };
    const activityTarget = videoElement?.parentElement ?? videoElement;
    activityTarget?.addEventListener("pointerdown", markActive, { passive: true });
    activityTarget?.addEventListener("wheel", markActive, { passive: true });
    activityTarget?.addEventListener("keydown", markActive);
    document.addEventListener("visibilitychange", markActive);
    const resizeObserver = typeof ResizeObserver === "undefined" || !videoElement
      ? null
      : new ResizeObserver(() => { void sendTelemetry(); });
    if (videoElement) resizeObserver?.observe(videoElement);
    control.addEventListener("open", () => {
      void sendTelemetry();
      telemetryTimer = window.setInterval(() => { void sendTelemetry(); }, 1_000);
    }, { once: true });

    startupTimer = setTimeout(() => {
      if (!receivedFrame) fail("WebRTC screen stream did not produce a frame");
    }, 8_000);

    void (async () => {
      try {
        const initialTelemetry = {
          viewportWidth: videoElement?.clientWidth ?? 0,
          devicePixelRatio: window.devicePixelRatio,
          visible: document.visibilityState === "visible",
          active: true,
        };
        await peer.setLocalDescription(await peer.createOffer());
        await waitForIceGathering(peer);
        const offer = peer.localDescription;
        if (!offer) throw new Error("WebRTC screen offer was not created");
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ offer: { type: offer.type, sdp: offer.sdp }, initialTelemetry }),
        });
        const reply = await response.json() as {
          answer?: RTCSessionDescriptionInit;
          error?: string;
        };
        if (!response.ok || !reply.answer) {
          throw new Error(reply.error ?? `WebRTC screen signaling failed (${response.status})`);
        }
        await peer.setRemoteDescription(reply.answer);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      stopped = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (telemetryTimer) clearInterval(telemetryTimer);
      resizeObserver?.disconnect();
      activityTarget?.removeEventListener("pointerdown", markActive);
      activityTarget?.removeEventListener("wheel", markActive);
      activityTarget?.removeEventListener("keydown", markActive);
      document.removeEventListener("visibilitychange", markActive);
      const video = videoElement;
      if (videoFrameCallback && video) video.cancelVideoFrameCallback(videoFrameCallback);
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      control.close();
      peer.close();
    };
  }, [endpoint, token, enabled, videoRef]);
}
