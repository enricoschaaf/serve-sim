export interface BrowserCameraDevice {
  id: string;
  name: string;
}

export interface BrowserCameraFeed {
  stop(): void;
}

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
  transport: "webrtc-media" | "websocket";
  roundTripTimeMs?: number;
  jitterMs?: number;
  packetsLost?: number;
  deliveryDelayMs?: number;
}

export const BROWSER_CAMERA_IDENTITY_WIDTH = 960;
export const BROWSER_CAMERA_IDENTITY_HEIGHT = 720;
export const BROWSER_CAMERA_FRAMES_PER_SECOND = 30;
export const BROWSER_CAMERA_MAX_BUFFERED_BYTES = 128 * 1024;
export const BROWSER_CAMERA_KEYFRAME_INTERVAL = BROWSER_CAMERA_FRAMES_PER_SECOND * 5;
export const BROWSER_CAMERA_STATS_WINDOW_MS = 3_000;

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
    resizeMode: "crop-and-scale",
  } as MediaTrackConstraints & { resizeMode: "crop-and-scale" };
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
  const evenDimension = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  const evenOffset = (value: number) => Math.max(0, Math.floor(value / 2) * 2);
  const targetAspectRatio = BROWSER_CAMERA_IDENTITY_WIDTH / BROWSER_CAMERA_IDENTITY_HEIGHT;
  const sourceAspectRatio = width / height;
  const sourceWidth4x3 = sourceAspectRatio > targetAspectRatio
    ? evenDimension(height * targetAspectRatio)
    : evenDimension(width);
  const sourceHeight4x3 = sourceAspectRatio > targetAspectRatio
    ? evenDimension(height)
    : evenDimension(width / targetAspectRatio);
  const scale = Math.min(
    1,
    BROWSER_CAMERA_IDENTITY_WIDTH / sourceWidth4x3,
    BROWSER_CAMERA_IDENTITY_HEIGHT / sourceHeight4x3,
  );
  return {
    sourceX: evenOffset((width - sourceWidth4x3) / 2),
    sourceY: evenOffset((height - sourceHeight4x3) / 2),
    sourceWidth: sourceWidth4x3,
    sourceHeight: sourceHeight4x3,
    outputWidth: evenDimension(sourceWidth4x3 * scale),
    outputHeight: evenDimension(sourceHeight4x3 * scale),
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
): number {
  const pixels = width * height;
  return pixels >= BROWSER_CAMERA_IDENTITY_WIDTH * BROWSER_CAMERA_IDENTITY_HEIGHT
    ? 4_000_000
    : 2_500_000;
}

export function browserCameraEncoderConfig(
  width: number,
  height: number,
): VideoEncoderConfig {
  return {
    width,
    height,
    bitrate: browserCameraBitrate(width, height),
    framerate: BROWSER_CAMERA_FRAMES_PER_SECOND,
    bitrateMode: "variable" as const,
    hardwareAcceleration: "prefer-hardware" as const,
    latencyMode: "realtime" as const,
    avc: { format: "avc" as const },
    codec: "avc1.42E01F",
  };
}

export function browserCameraRollingFramesPerSecond(
  frameTimes: readonly number[],
  now: number,
  startedAt: number,
): number {
  const cutoff = now - BROWSER_CAMERA_STATS_WINDOW_MS;
  const count = frameTimes.filter((time) => time >= cutoff).length;
  if (count === 0) return 0;
  const observedFor = Math.max(1_000, now - Math.max(startedAt, cutoff));
  return Math.round(count * 1_000 / observedFor);
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

interface BrowserMediaStreamTrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}

interface BrowserMediaStreamTrackGeneratorConstructor {
  new(options: { kind: "video" }): BrowserMediaStreamTrackGenerator;
}

function mediaStreamTrackProcessor(): BrowserMediaStreamTrackProcessorConstructor | null {
  const candidate = (globalThis as typeof globalThis & {
    MediaStreamTrackProcessor?: BrowserMediaStreamTrackProcessorConstructor;
  }).MediaStreamTrackProcessor;
  return candidate ?? null;
}

function mediaStreamTrackGenerator(): BrowserMediaStreamTrackGeneratorConstructor | null {
  const candidate = (globalThis as typeof globalThis & {
    MediaStreamTrackGenerator?: BrowserMediaStreamTrackGeneratorConstructor;
  }).MediaStreamTrackGenerator;
  return candidate ?? null;
}

interface PreparedBrowserCameraTrack {
  track: MediaStreamTrack;
  width: number;
  height: number;
  stop(): void;
}

async function prepareBrowserCameraTrack(
  source: MediaStreamTrack,
  onError: (message: string) => void,
): Promise<PreparedBrowserCameraTrack> {
  try {
    await source.applyConstraints(browserCameraVideoConstraints(source.getSettings().deviceId ?? ""));
  } catch {}
  const settings = source.getSettings();
  const layout = browserCameraFrameLayout(
    settings.width ?? BROWSER_CAMERA_IDENTITY_WIDTH,
    settings.height ?? BROWSER_CAMERA_IDENTITY_HEIGHT,
  );
  if (browserCameraCanEncodeVideoDirectly(layout)) {
    return {
      track: source,
      width: layout.outputWidth,
      height: layout.outputHeight,
      stop() {},
    };
  }

  const Processor = mediaStreamTrackProcessor();
  const Generator = mediaStreamTrackGenerator();
  if (!Processor || !Generator) {
    throw new Error("This browser cannot crop the camera to the required 4:3 frame.");
  }
  const reader = new Processor({ track: source }).readable.getReader();
  const generated = new Generator({ kind: "video" });
  const writer = generated.writable.getWriter();
  let stopped = false;
  void (async () => {
    try {
      while (!stopped) {
        const { done, value: frame } = await reader.read();
        if (done || !frame) break;
        const frameLayout = browserCameraFrameLayout(frame.displayWidth, frame.displayHeight);
        let cropped: VideoFrame | null = null;
        try {
          cropped = new VideoFrame(frame, {
            visibleRect: {
              x: frameLayout.sourceX,
              y: frameLayout.sourceY,
              width: frameLayout.sourceWidth,
              height: frameLayout.sourceHeight,
            },
            displayWidth: frameLayout.outputWidth,
            displayHeight: frameLayout.outputHeight,
            timestamp: frame.timestamp,
            ...(frame.duration == null ? {} : { duration: frame.duration }),
          });
          await writer.write(cropped);
        } finally {
          cropped?.close();
          frame.close();
        }
      }
    } catch (error) {
      if (!stopped) onError(error instanceof Error ? error.message : String(error));
    }
  })();
  return {
    track: generated,
    width: layout.outputWidth,
    height: layout.outputHeight,
    stop() {
      if (stopped) return;
      stopped = true;
      void reader.cancel().catch(() => {});
      void writer.abort().catch(() => {});
      generated.stop();
    },
  };
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
  readonly kind: "webrtc-media" | "websocket";
  readonly handlesMedia: boolean;
  readonly bufferedAmount: number;
  sendConfiguration(packet: ArrayBuffer): void;
  sendFrame(packet: ArrayBuffer): void;
  stop(): void;
}

type BrowserCameraControl = {
  error?: string;
  keyFrameRequired?: boolean;
  stats?: {
    deliveredFrames?: number;
    droppedFrames?: number;
    lastDeliveryDelayMs?: number;
  };
};

type BrowserRemoteInboundRtpStats = RTCStats & {
  type: "remote-inbound-rtp";
  kind?: string;
  jitter?: number;
  packetsLost?: number;
  roundTripTime?: number;
};

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
  stream: MediaStream,
  onControl: (control: BrowserCameraControl) => void,
  onStats?: (stats: BrowserCameraStats) => void,
): Promise<BrowserCameraTransport> {
  if (typeof RTCPeerConnection === "undefined") throw new Error("WebRTC is unavailable");
  const peer = new RTCPeerConnection({ iceServers: [] });
  const control = peer.createDataChannel("camera-control", { ordered: true });
  const sourceTrack = stream.getVideoTracks()[0];
  if (!sourceTrack) throw new Error("Browser camera has no video track");
  const prepared = await prepareBrowserCameraTrack(sourceTrack, (error) => onControl({ error }));
  const track = prepared.track;
  track.contentHint = "detail";
  const sender = peer.addTrack(track, new MediaStream([track]));
  const transceiver = peer.getTransceivers().find((candidate) => candidate.sender === sender);
  const availableH264Codecs = RTCRtpSender.getCapabilities("video")?.codecs.filter(
    (codec) => codec.mimeType.toLowerCase() === "video/h264",
  ) ?? [];
  const baselineCodecs = availableH264Codecs.filter((codec) =>
    /profile-level-id=42/i.test(codec.sdpFmtpLine ?? "")
    && /packetization-mode=1/i.test(codec.sdpFmtpLine ?? ""));
  const h264Codecs = baselineCodecs.length > 0 ? baselineCodecs : availableH264Codecs;
  if (transceiver && h264Codecs.length > 0) transceiver.setCodecPreferences(h264Codecs);
  const senderParameters = sender.getParameters();
  const encoding = senderParameters.encodings[0] ?? {};
  senderParameters.encodings = [{
    ...encoding,
    maxBitrate: browserCameraBitrate(prepared.width, prepared.height),
    maxFramerate: BROWSER_CAMERA_FRAMES_PER_SECOND,
    scaleResolutionDownBy: 1,
  }];
  senderParameters.degradationPreference = "maintain-resolution";
  await sender.setParameters(senderParameters);
  control.binaryType = "arraybuffer";
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
    await waitForDataChannel(control);
  } catch (error) {
    prepared.stop();
    control.close();
    peer.close();
    throw error;
  }

  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed") {
      onControl({ error: "WebRTC camera connection failed" });
    }
  });
  let previousFrames = 0;
  let previousBytes = 0;
  let previousAt = performance.now();
  let helperStats: BrowserCameraControl["stats"];
  const statsListener = (event: MessageEvent) => {
    void eventText(event.data).then((text) => {
      try {
        const message = JSON.parse(text) as BrowserCameraControl;
        if (message.stats) helperStats = message.stats;
      } catch {}
    });
  };
  control.addEventListener("message", statsListener);
  const statsTimer = window.setInterval(() => {
    void peer.getStats(track).then((report) => {
      let outbound: RTCOutboundRtpStreamStats | undefined;
      let remote: BrowserRemoteInboundRtpStats | undefined;
      let codec = "video/H264";
      report.forEach((value) => {
        if (value.type === "outbound-rtp" && value.kind === "video") outbound = value as RTCOutboundRtpStreamStats;
        if (value.type === "remote-inbound-rtp" && value.kind === "video") remote = value as BrowserRemoteInboundRtpStats;
        if (value.type === "codec" && value.mimeType) codec = value.mimeType;
      });
      const now = performance.now();
      const elapsed = Math.max(1, now - previousAt);
      const frames = outbound?.framesEncoded ?? previousFrames;
      const bytes = outbound?.bytesSent ?? previousBytes;
      onStats?.({
        inputWidth: sourceTrack.getSettings().width ?? BROWSER_CAMERA_IDENTITY_WIDTH,
        inputHeight: sourceTrack.getSettings().height ?? BROWSER_CAMERA_IDENTITY_HEIGHT,
        outputWidth: prepared.width,
        outputHeight: prepared.height,
        bitrate: Math.round((bytes - previousBytes) * 8_000 / elapsed),
        codec,
        encodedFramesPerSecond: Math.round((frames - previousFrames) * 1_000 / elapsed),
        skippedFrames: helperStats?.droppedFrames ?? 0,
        bufferedBytes: 0,
        directVideoFrames: true,
        transport: "webrtc-media",
        roundTripTimeMs: remote?.roundTripTime == null ? undefined : Math.round(remote.roundTripTime * 1_000),
        jitterMs: remote?.jitter == null ? undefined : Math.round(remote.jitter * 1_000),
        packetsLost: remote?.packetsLost,
        deliveryDelayMs: helperStats?.lastDeliveryDelayMs == null
          ? undefined
          : Math.round(helperStats.lastDeliveryDelayMs),
      });
      previousFrames = frames;
      previousBytes = bytes;
      previousAt = now;
    }).catch(() => {});
  }, 1_000);
  return {
    kind: "webrtc-media",
    handlesMedia: true,
    get bufferedAmount() { return 0; },
    sendConfiguration() {},
    sendFrame() {},
    stop() {
      window.clearInterval(statsTimer);
      control.removeEventListener("message", statsListener);
      control.close();
      peer.close();
      prepared.stop();
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
    handlesMedia: false,
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
  onError,
  onStats,
}: {
  endpoint: string;
  webRtcEndpoint?: string;
  token: string;
  stream: MediaStream;
  onError: (message: string) => void;
  onStats?: (stats: BrowserCameraStats) => void;
}): Promise<BrowserCameraFeed> {
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

  let stopped = false;
  let keyFrameRequired = true;
  const onControl = (reply: BrowserCameraControl) => {
    if (reply.keyFrameRequired) keyFrameRequired = true;
    if (reply.error && !stopped) onError(reply.error);
  };
  let webRtcError: unknown;
  if (webRtcEndpoint) {
    try {
      const mediaTransport = await openBrowserCameraWebRtcTransport(
        webRtcEndpoint,
        token,
        stream,
        onControl,
        onStats,
      );
      return {
        stop() {
          if (stopped) return;
          stopped = true;
          mediaTransport.stop();
          releaseVideo();
        },
      };
    } catch (error) {
      webRtcError = error;
    }
  }

  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    releaseVideo();
    throw new Error("This browser does not support H.264 webcam streaming.");
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

  const requestedEncoderConfig = browserCameraEncoderConfig(canvas.width, canvas.height);
  let support: VideoEncoderSupport;
  try {
    support = await VideoEncoder.isConfigSupported(requestedEncoderConfig);
  } catch {
    releaseVideo();
    throw new Error("This browser cannot encode the webcam as H.264.");
  }
  if (!support.supported) {
    releaseVideo();
    throw new Error("This browser cannot encode the webcam as H.264 Baseline.");
  }
  const encoderConfig = support.config ?? requestedEncoderConfig;

  let transport: BrowserCameraTransport;
  try {
    transport = await openBrowserCameraWebSocketTransport(endpoint, token, onControl);
  } catch (error) {
    releaseVideo();
    throw new Error(webRtcError
      ? `WebRTC failed (${webRtcError instanceof Error ? webRtcError.message : String(webRtcError)}); `
        + `WebSocket fallback failed (${error instanceof Error ? error.message : String(error)})`
      : error instanceof Error ? error.message : String(error));
  }

  let frameIndex = 0;
  let timestamp = 0;
  let encodedSequence = 0;
  const encoderStartedAt = performance.now();
  const encodedFrameTimes: number[] = [];
  let skippedFrames = 0;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      if (stopped) return;
      const description = metadata?.decoderConfig?.description;
      try {
        if (description) transport.sendConfiguration(browserCameraH264ConfigPacket(description));
        transport.sendFrame(browserCameraH264FramePacket(chunk, encodedSequence++));
        encodedFrameTimes.push(performance.now());
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    },
    error(error) {
      if (!stopped) onError(`Browser H.264 encoder failed: ${error.message}`);
    },
  });
  try {
    encoder.configure(encoderConfig);
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
    const now = performance.now();
    const cutoff = now - BROWSER_CAMERA_STATS_WINDOW_MS;
    while (encodedFrameTimes[0] !== undefined && encodedFrameTimes[0] < cutoff) {
      encodedFrameTimes.shift();
    }
    onStats?.({
      inputWidth: sourceWidth,
      inputHeight: sourceHeight,
      outputWidth: canvas.width,
      outputHeight: canvas.height,
      bitrate: encoderConfig.bitrate ?? 0,
      codec: encoderConfig.codec,
      encodedFramesPerSecond: browserCameraRollingFramesPerSecond(
        encodedFrameTimes,
        now,
        encoderStartedAt,
      ),
      skippedFrames,
      bufferedBytes: transport.bufferedAmount,
      directVideoFrames,
      transport: "websocket",
    });
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
