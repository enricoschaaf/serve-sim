export interface BrowserCameraDevice {
  id: string;
  name: string;
}

export interface BrowserCameraFeed {
  stop(): void;
}

export function browserCameraVideoConstraints(deviceId: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 30, max: 30 },
  };
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

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Could not encode browser camera frame")),
      "image/jpeg",
      0.72,
    );
  });
}

export async function startBrowserCameraFeed({
  endpoint,
  token,
  stream,
  onError,
}: {
  endpoint: string;
  token: string;
  stream: MediaStream;
  onError: (message: string) => void;
}): Promise<BrowserCameraFeed> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(video);
  video.srcObject = stream;
  try {
    await video.play();
    await waitForVideo(video);
  } catch (error) {
    video.pause();
    video.srcObject = null;
    video.remove();
    throw error;
  }

  const canvas = document.createElement("canvas");
  const sourceWidth = video.videoWidth || 640;
  const sourceHeight = video.videoHeight || 480;
  const scale = Math.min(1, 640 / sourceWidth, 480 / sourceHeight);
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Browser camera canvas is unavailable");

  const socket = new WebSocket(browserCameraSocketUrl(endpoint, window.location.href));
  socket.binaryType = "arraybuffer";
  try {
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
          let reply: { ready?: boolean; error?: string };
          try { reply = JSON.parse(text) as typeof reply; } catch { return; }
          if (reply.error) settle(new Error(reply.error));
          else if (reply.ready) settle();
        });
      };
    });
  } catch (error) {
    socket.close();
    video.pause();
    video.srcObject = null;
    video.remove();
    throw error;
  }

  let stopped = false;
  let encoding = false;
  const sendFrame = async () => {
    if (stopped || encoding || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 512 * 1024 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    encoding = true;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      socket.send(await canvasBlob(canvas).then((blob) => blob.arrayBuffer()));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      encoding = false;
    }
  };
  const stopFrameLoop = startBrowserCameraFrameLoop(video, () => { void sendFrame(); });
  void sendFrame();

  socket.onmessage = (event) => {
    void eventText(event.data).then((text) => {
      try {
        const reply = JSON.parse(text) as { error?: string };
        if (reply.error) onError(reply.error);
      } catch {}
    });
  };
  socket.onclose = () => {
    if (!stopped) onError("Browser camera connection closed");
  };

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      stopFrameLoop();
      socket.close();
      video.pause();
      video.srcObject = null;
      video.remove();
    },
  };
}
