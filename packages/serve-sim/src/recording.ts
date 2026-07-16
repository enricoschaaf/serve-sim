import { spawn } from "child_process";

export type TimeRange = {
  start: number;
  end: number;
};

const FREEZE_DETECTION_SECONDS = 1;
const FREEZE_NOISE_THRESHOLD = "-50dB";
const STABLE_SCREEN_HOLD_SECONDS = 1.5;
const OUTPUT_FRAME_RATE = 30;
const PROCESS_TIMEOUT_MS = 120_000;

export function parseFreezeRanges(stderr: string, duration: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  const events = stderr.matchAll(/lavfi\.freezedetect\.freeze_(start|end):\s*([0-9.]+)/g);
  let start: number | undefined;
  for (const event of events) {
    const value = Number(event[2]);
    if (!Number.isFinite(value)) continue;
    if (event[1] === "start") {
      start = value;
    } else if (start != null && value > start) {
      ranges.push({ start, end: value });
      start = undefined;
    }
  }
  if (start != null && duration > start) ranges.push({ start, end: duration });
  return ranges;
}

export function keptRecordingRanges(
  duration: number,
  freezes: TimeRange[],
  holdSeconds = STABLE_SCREEN_HOLD_SECONDS,
): TimeRange[] {
  const ranges: TimeRange[] = [];
  let cursor = 0;
  for (const freeze of freezes) {
    const start = Math.max(cursor, Math.min(duration, freeze.start));
    const end = Math.max(start, Math.min(duration, freeze.end));
    const keptEnd = Math.min(end, start + holdSeconds);
    if (keptEnd > cursor) ranges.push({ start: cursor, end: keptEnd });
    cursor = end;
  }
  if (duration > cursor) ranges.push({ start: cursor, end: duration });
  return ranges;
}

export async function compactRecording(input: string, output: string): Promise<void> {
  const durationResult = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    input,
  ]);
  const duration = Number(durationResult.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("ffprobe returned an invalid recording duration");

  const detection = await run("ffmpeg", [
    "-hide_banner", "-nostats",
    "-i", input,
    "-vf", `freezedetect=n=${FREEZE_NOISE_THRESHOLD}:d=${FREEZE_DETECTION_SECONDS}`,
    "-an", "-f", "null", "-",
  ]);
  const ranges = keptRecordingRanges(duration, parseFreezeRanges(detection.stderr, duration));
  const filters = ranges.map((range, index) =>
    `[0:v]trim=start=${seconds(range.start)}:end=${seconds(range.end)},setpts=PTS-STARTPTS[v${index}]`
  );
  const inputs = ranges.map((_, index) => `[v${index}]`).join("");
  filters.push(`${inputs}concat=n=${ranges.length}:v=1:a=0[out]`);

  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", input,
    "-filter_complex", filters.join(";"),
    "-map", "[out]",
    "-an", "-r", String(OUTPUT_FRAME_RATE),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    output,
  ]);
}

function seconds(value: number): string {
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), PROCESS_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`));
    });
  });
}
