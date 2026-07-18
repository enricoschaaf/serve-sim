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

    startupTimer = setTimeout(() => {
      if (!receivedFrame) fail("WebRTC screen stream did not produce a frame");
    }, 8_000);

    void (async () => {
      try {
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
          body: JSON.stringify({ offer: { type: offer.type, sdp: offer.sdp } }),
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
      const video = videoElement;
      if (videoFrameCallback && video) video.cancelVideoFrameCallback(videoFrameCallback);
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      peer.close();
    };
  }, [endpoint, token, enabled, videoRef]);
}
