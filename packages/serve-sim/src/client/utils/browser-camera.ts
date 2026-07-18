export interface BrowserCameraDevice {
  id: string;
  name: string;
}

export interface BrowserCameraFeed {
  stop(): void;
}

export type BrowserCameraQuality = "balanced" | "detail";

export interface BrowserCameraStats {
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  bitrate: number;
  codec: string;
  encodedFramesPerSecond: number;
  skippedFrames: number;
  bufferedBytes: number;
  directVideoFrames: boolean;
  transport: "webrtc" | "websocket";
}

export const BROWSER_CAMERA_IDENTITY_WIDTH = 960;
export const BROWSER_CAMERA_IDENTITY_HEIGHT = 720;
export const BROWSER_CAMERA_FRAMES_PER_SECOND = 30;
export const BROWSER_CAMERA_MAX_BUFFERED_BYTES = 128 * 1024;
export const BROWSER_CAMERA_KEYFRAME_INTERVAL = BROWSER_CAMERA_FRAMES_PER_SECOND * 5;

export function browserCameraShouldEncodeKeyFrame(
  frameIndex: number,
  keyFrameRequired: boolean,
): boolean {
  return keyFrameRequired || frameIndex % BROWSER_CAMERA_KEYFRAME_INTERVAL === 0;
}

export function browserCameraVideoConstraints(deviceId: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: BROWSER_CAMERA_IDENTITY_WIDTH },
    height: { ideal: 720 },
    aspectRatio: {
      ideal: BROWSER_CAMERA_IDENTITY_WIDTH / BROWSER_CAMERA_IDENTITY_HEIGHT,
    },
    frameRate: {
      ideal: BROWSER_CAMERA_FRAMES_PER_SECOND,
      max: BROWSER_CAMERA_FRAMES_PER_SECOND,
    },
  };
}

export interface BrowserCameraFrameLayout {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
}

export function browserCameraFrameLayout(
  sourceWidth: number,
  sourceHeight: number,
): BrowserCameraFrameLayout {
  const width = Math.max(2, sourceWidth || BROWSER_CAMERA_IDENTITY_WIDTH);
  const height = Math.max(2, sourceHeight || 720);
  const scale = Math.min(1, 1280 / width, 720 / height);
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  return {
    sourceX: 0,
    sourceY: 0,
    sourceWidth: width,
    sourceHeight: height,
    outputWidth: even(width * scale),
    outputHeight: even(height * scale),
  };
}

export function browserCameraCanEncodeVideoDirectly(layout: BrowserCameraFrameLayout): boolean {
  return layout.sourceX === 0
    && layout.sourceY === 0
    && layout.sourceWidth === layout.outputWidth
    && layout.sourceHeight === layout.outputHeight;
}

export function browserCameraBitrate(
  width: number,
  height: number,
  quality: BrowserCameraQuality = "balanced",
): number {
  const pixels = width * height;
  if (quality === "balanced") {
    return pixels >= BROWSER_CAMERA_IDENTITY_WIDTH * BROWSER_CAMERA_IDENTITY_HEIGHT
      ? 2_500_000
      : 1_800_000;
  }
  if (pixels >= 1280 * 720) return 3_500_000;
  if (pixels >= BROWSER_CAMERA_IDENTITY_WIDTH * BROWSER_CAMERA_IDENTITY_HEIGHT) {
    return 3_000_000;
  }
  return 2_000_000;
}

export function browserCameraEncoderConfigs(
  width: number,
  height: number,
  quality: BrowserCameraQuality,
): VideoEncoderConfig[] {
  const base = {
    width,
    height,
    bitrate: browserCameraBitrate(width, height, quality),
    framerate: BROWSER_CAMERA_FRAMES_PER_SECOND,
    bitrateMode: "variable" as const,
    hardwareAcceleration: "prefer-hardware" as const,
    latencyMode: "realtime" as const,
    avc: { format: "avc" as const },
  };
  return quality === "detail"
    ? [
        { ...base, codec: "avc1.64001F" },
        { ...base, codec: "avc1.42E01F" },
      ]
    : [{ ...base, codec: "avc1.42E01F" }];
}

export function browserVideoDevices(
  devices: Array<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>,
): BrowserCameraDevice[] {
  let index = 0;
  return devices.flatMap((device) => {
    if (device.kind !== "videoinput") return [];
    index++;
    return [{
      id: device.deviceId,
      name: device.label || `Browser camera ${index}`,
    }];
  });
}

export function browserCameraSocketUrl(endpoint: string, pageUrl: string): string {
  const url = new URL(endpoint, pageUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function startBrowserCameraFrameLoop(
  video: Pick<HTMLVideoElement, "requestVideoFrameCallback" | "cancelVideoFrameCallback">,
  onFrame: () => void,
  maxFramesPerSecond = 30,
): () => void {
  const requestFrame = video.requestVideoFrameCallback?.bind(video);
  const cancelFrame = video.cancelVideoFrameCallback?.bind(video);
  if (requestFrame && cancelFrame) {
    const minimumInterval = 1000 / maxFramesPerSecond - 1;
    let stopped = false;
    let callbackId = 0;
    let lastFrameAt = Number.NEGATIVE_INFINITY;
    const handleFrame: VideoFrameRequestCallback = (now) => {
      if (stopped) return;
      if (now - lastFrameAt >= minimumInterval) {
        lastFrameAt = now;
        onFrame();
      }
      callbackId = requestFrame(handleFrame);
    };
    callbackId = requestFrame(handleFrame);
    return () => {
      if (stopped) return;
      stopped = true;
      cancelFrame(callbackId);
    };
  }

  const interval = window.setInterval(onFrame, 1000 / maxFramesPerSecond);
  return () => window.clearInterval(interval);
}

async function eventText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return "";
}

interface BrowserMediaStreamTrackProcessor {
  readable: ReadableStream<VideoFrame>;
}

interface BrowserMediaStreamTrackProcessorConstructor {
  new(options: { track: MediaStreamTrack }): BrowserMediaStreamTrackProcessor;
}

function mediaStreamTrackProcessor(): BrowserMediaStreamTrackProcessorConstructor | null {
  const candidate = (globalThis as typeof globalThis & {
    MediaStreamTrackProcessor?: BrowserMediaStreamTrackProcessorConstructor;
  }).MediaStreamTrackProcessor;
  return candidate ?? null;
}

function waitForVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Browser camera did not produce video within 5 seconds"));
    }, 5_000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Browser camera did not produce video"));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

const H264_CONFIG_PACKET = 1;
const H264_FRAME_PACKET = 2;

export function browserCameraH264ConfigPacket(description: AllowSharedBufferSource): ArrayBuffer {
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  const packet = new Uint8Array(1 + bytes.byteLength);
  packet[0] = H264_CONFIG_PACKET;
  packet.set(bytes, 1);
  return packet.buffer;
}

export function browserCameraH264FramePacket(
  chunk: EncodedVideoChunk,
  sequence: number,
): ArrayBuffer {
  const packet = new Uint8Array(6 + chunk.byteLength);
  packet[0] = H264_FRAME_PACKET;
  packet[1] = chunk.type === "key" ? 1 : 0;
  new DataView(packet.buffer).setUint32(2, sequence >>> 0);
  chunk.copyTo(packet.subarray(6));
  return packet.buffer;
}

interface BrowserCameraTransport {
  readonly kind: "webrtc" | "websocket";
  readonly bufferedAmount: number;
  sendConfiguration(packet: ArrayBuffer): void;
  sendFrame(packet: ArrayBuffer): void;
  stop(): void;
}

type BrowserCameraControl = { error?: string; keyFrameRequired?: boolean };

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("WebRTC ICE gathering timed out"));
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

function waitForDataChannel(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("WebRTC camera channel timed out"));
    }, 8_000);
    const onOpen = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("WebRTC camera channel closed")); };
    const cleanup = () => {
      window.clearTimeout(timeout);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
    };
    channel.addEventListener("open", onOpen, { once: true });
    channel.addEventListener("close", onClose, { once: true });
  });
}

async function openBrowserCameraWebRtcTransport(
  endpoint: string,
  token: string,
  onControl: (control: BrowserCameraControl) => void,
): Promise<BrowserCameraTransport> {
  if (typeof RTCPeerConnection === "undefined") throw new Error("WebRTC is unavailable");
  const peer = new RTCPeerConnection({ iceServers: [] });
  const control = peer.createDataChannel("camera-control", { ordered: true });
  const frames = peer.createDataChannel("camera-frames", { ordered: false, maxRetransmits: 0 });
  control.binaryType = "arraybuffer";
  frames.binaryType = "arraybuffer";
  control.addEventListener("message", (event) => {
    void eventText(event.data).then((text) => {
      try { onControl(JSON.parse(text) as BrowserCameraControl); } catch {}
    });
  });
  try {
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIceGathering(peer);
    const offer = peer.localDescription;
    if (!offer) throw new Error("WebRTC camera offer was not created");
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
      throw new Error(reply.error ?? `WebRTC signaling failed (${response.status})`);
    }
    await peer.setRemoteDescription(reply.answer);
    await Promise.all([waitForDataChannel(control), waitForDataChannel(frames)]);
  } catch (error) {
    control.close();
    frames.close();
    peer.close();
    throw error;
  }

  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed") {
      onControl({ error: "WebRTC camera connection failed" });
    }
  });
  return {
    kind: "webrtc",
    get bufferedAmount() { return control.bufferedAmount + frames.bufferedAmount; },
    sendConfiguration(packet) { control.send(packet); },
    sendFrame(packet) { frames.send(packet); },
    stop() {
      control.close();
      frames.close();
      peer.close();
    },
  };
}

async function openBrowserCameraWebSocketTransport(
  endpoint: string,
  token: string,
  onControl: (control: BrowserCameraControl) => void,
): Promise<BrowserCameraTransport> {
  const socket = new WebSocket(browserCameraSocketUrl(endpoint, window.location.href));
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => settle(new Error("Browser camera connection timed out")),
      5_000,
    );
    socket.onopen = () => socket.send(JSON.stringify({ token }));
    socket.onerror = () => settle(new Error("Browser camera connection failed"));
    socket.onclose = () => settle(new Error("Browser camera connection closed"));
    socket.onmessage = (event) => {
      void eventText(event.data).then((text) => {
        let reply: BrowserCameraControl & { ready?: boolean };
        try { reply = JSON.parse(text) as typeof reply; } catch { return; }
        if (reply.error) settle(new Error(reply.error));
        else if (reply.ready) settle();
      });
    };
  });
  socket.onmessage = (event) => {
    void eventText(event.data).then((text) => {
      try { onControl(JSON.parse(text) as BrowserCameraControl); } catch {}
    });
  };
  socket.onclose = () => onControl({ error: "Browser camera connection closed" });
  return {
    kind: "websocket",
    get bufferedAmount() { return socket.bufferedAmount; },
    sendConfiguration(packet) { socket.send(packet); },
    sendFrame(packet) { socket.send(packet); },
    stop() { socket.close(); },
  };
}

export async function startBrowserCameraFeed({
  endpoint,
  webRtcEndpoint,
  token,
  stream,
  quality = "balanced",
  onError,
  onStats,
}: {
  endpoint: string;
  webRtcEndpoint?: string;
  token: string;
  stream: MediaStream;
  quality?: BrowserCameraQuality;
  onError: (message: string) => void;
  onStats?: (stats: BrowserCameraStats) => void;
}): Promise<BrowserCameraFeed> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    throw new Error("This browser does not support H.264 webcam streaming.");
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(video);
  video.srcObject = stream;
  const releaseVideo = () => {
    video.pause();
    video.srcObject = null;
    video.remove();
  };
  try {
    await video.play();
    await waitForVideo(video);
  } catch (error) {
    releaseVideo();
    throw error;
  }

  const canvas = document.createElement("canvas");
  const sourceWidth = video.videoWidth || 640;
  const sourceHeight = video.videoHeight || 480;
  const layout = browserCameraFrameLayout(sourceWidth, sourceHeight);
  const directVideoFrames = browserCameraCanEncodeVideoDirectly(layout);
  canvas.width = layout.outputWidth;
  canvas.height = layout.outputHeight;
  const context = directVideoFrames ? null : canvas.getContext("2d", { alpha: false });
  if (!directVideoFrames && !context) {
    releaseVideo();
    throw new Error("Browser camera canvas is unavailable");
  }

  let support: VideoEncoderSupport | null = null;
  let encoderConfig: VideoEncoderConfig | null = null;
  for (const candidate of browserCameraEncoderConfigs(canvas.width, canvas.height, quality)) {
    try {
      const candidateSupport = await VideoEncoder.isConfigSupported(candidate);
      if (candidateSupport.supported) {
        support = candidateSupport;
        encoderConfig = candidate;
        break;
      }
    } catch {}
  }
  if (!support || !encoderConfig) {
    releaseVideo();
    throw new Error("This browser cannot encode the webcam as H.264.");
  }

  let stopped = false;
  let keyFrameRequired = true;
  const onControl = (reply: BrowserCameraControl) => {
    if (reply.keyFrameRequired) keyFrameRequired = true;
    if (reply.error && !stopped) onError(reply.error);
  };
  let transport: BrowserCameraTransport;
  try {
    transport = webRtcEndpoint
      ? await openBrowserCameraWebRtcTransport(webRtcEndpoint, token, onControl)
      : await openBrowserCameraWebSocketTransport(endpoint, token, onControl);
  } catch (error) {
    if (!webRtcEndpoint) {
      releaseVideo();
      throw error;
    }
    try {
      transport = await openBrowserCameraWebSocketTransport(endpoint, token, onControl);
    } catch (fallbackError) {
      releaseVideo();
      throw new Error(
        `WebRTC failed (${error instanceof Error ? error.message : String(error)}); `
        + `WebSocket fallback failed (${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)})`,
      );
    }
  }

  let frameIndex = 0;
  let timestamp = 0;
  let encodedSequence = 0;
  let encodedFrames = 0;
  let skippedFrames = 0;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      if (stopped) return;
      const description = metadata?.decoderConfig?.description;
      try {
        if (description) transport.sendConfiguration(browserCameraH264ConfigPacket(description));
        transport.sendFrame(browserCameraH264FramePacket(chunk, encodedSequence++));
        encodedFrames++;
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    },
    error(error) {
      if (!stopped) onError(`Browser H.264 encoder failed: ${error.message}`);
    },
  });
  try {
    encoder.configure(support.config ?? encoderConfig);
  } catch (error) {
    transport.stop();
    releaseVideo();
    throw error;
  }

  const sendFrame = (sourceFrame?: VideoFrame) => {
    if (stopped) return;
    if (transport.bufferedAmount > BROWSER_CAMERA_MAX_BUFFERED_BYTES
        || encoder.encodeQueueSize > 1
        || (!sourceFrame && video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)) {
      skippedFrames++;
      return;
    }
    try {
      let frame: VideoFrame;
      let ownsFrame = false;
      if (sourceFrame) {
        frame = sourceFrame;
      } else if (directVideoFrames) {
        frame = new VideoFrame(video, { timestamp });
        ownsFrame = true;
      } else {
        context!.drawImage(
          video,
          layout.sourceX,
          layout.sourceY,
          layout.sourceWidth,
          layout.sourceHeight,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        frame = new VideoFrame(canvas, { timestamp });
        ownsFrame = true;
      }
      const keyFrame = browserCameraShouldEncodeKeyFrame(frameIndex, keyFrameRequired);
      encoder.encode(frame, { keyFrame });
      if (ownsFrame) frame.close();
      keyFrameRequired = false;
      frameIndex++;
      timestamp += Math.round(1_000_000 / BROWSER_CAMERA_FRAMES_PER_SECOND);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };
  const Processor = directVideoFrames ? mediaStreamTrackProcessor() : null;
  const videoTrack = stream.getVideoTracks()[0];
  let stopFrameLoop: () => void;
  if (Processor && videoTrack) {
    const reader = new Processor({ track: videoTrack }).readable.getReader();
    let cancelled = false;
    void (async () => {
      try {
        while (!cancelled) {
          const { done, value: frame } = await reader.read();
          if (done || !frame) break;
          try {
            sendFrame(frame);
          } finally {
            frame.close();
          }
        }
      } catch (error) {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      }
    })();
    stopFrameLoop = () => {
      cancelled = true;
      void reader.cancel().catch(() => {});
    };
  } else {
    stopFrameLoop = startBrowserCameraFrameLoop(video, sendFrame);
    sendFrame();
  }
  const statsTimer = window.setInterval(() => {
    onStats?.({
      inputWidth: sourceWidth,
      inputHeight: sourceHeight,
      outputWidth: canvas.width,
      outputHeight: canvas.height,
      bitrate: encoderConfig!.bitrate ?? 0,
      codec: encoderConfig!.codec,
      encodedFramesPerSecond: encodedFrames,
      skippedFrames,
      bufferedBytes: transport.bufferedAmount,
      directVideoFrames,
      transport: transport.kind,
    });
    encodedFrames = 0;
    skippedFrames = 0;
  }, 1_000);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      window.clearInterval(statsTimer);
      stopFrameLoop();
      encoder.close();
      transport.stop();
      releaseVideo();
    },
  };
}
