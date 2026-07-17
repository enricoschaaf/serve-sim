import { spawn, spawnSync, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { createServer } from "net";
import { fileURLToPath } from "url";
import { axFrontmostAsync } from "./native";

export type XCTestRunnerStatus = {
  backend: "xctest";
  state: "warming" | "ready" | "degraded" | "stopped";
  error?: string;
};

type RunnerSession = {
  child?: ChildProcess;
  foregroundBundleId?: string;
  port?: number;
  state: XCTestRunnerStatus["state"];
  error?: string;
  generation: number;
  restart?: NodeJS.Timeout;
};

type Artifact = {
  derivedData: string;
  xctestrun: string;
};

type RunnerResponse = {
  ok?: boolean;
  tree?: unknown;
  error?: string;
};

const sessions = new Map<string, RunnerSession>();
let artifactPromise: Promise<Artifact> | undefined;
let shuttingDown = false;
const SNAPSHOT_TIMEOUT_MS = 3_000;
const STARTUP_TIMEOUT_MS = 90_000;

export function prewarmXCTestRunner(udid: string): void {
  let session = sessions.get(udid);
  if (!session) {
    session = { state: "warming", generation: 0 };
    sessions.set(udid, session);
  }
  if (session.state === "ready" || session.child || session.restart) return;
  session.state = "warming";
  session.error = undefined;
  const generation = ++session.generation;
  void startRunner(udid, session, generation);
}

export function prewarmXCTestRunners(udids: Iterable<string>): void {
  for (const udid of udids) prewarmXCTestRunner(udid);
}

export function xctestRunnerStatus(udid: string): XCTestRunnerStatus {
  const session = sessions.get(udid);
  if (!session) return { backend: "xctest", state: "stopped" };
  return {
    backend: "xctest",
    state: session.state,
    ...(session.error ? { error: session.error } : {}),
  };
}

export async function xctestDescribe(udid: string): Promise<string | null> {
  const session = sessions.get(udid);
  if (!session || session.state !== "ready" || !session.port) return null;
  try {
    const bundleId = session.foregroundBundleId ?? await refreshForeground(udid, session);
    if (!bundleId) return null;
    const response = await sendCommand(
      session.port,
      { command: "snapshot", bundleId },
      SNAPSHOT_TIMEOUT_MS,
    );
    if (!response.ok || !response.tree) throw new Error(response.error || "XCTest returned no tree");
    return JSON.stringify([response.tree]);
  } catch (error) {
    degradeAndRestart(udid, session, error);
    return null;
  }
}

export function invalidateXCTestForeground(udid: string): void {
  const session = sessions.get(udid);
  if (session) session.foregroundBundleId = undefined;
}

export function closeAllXCTestRunners(): void {
  shuttingDown = true;
  for (const session of sessions.values()) {
    if (session.restart) clearTimeout(session.restart);
    session.restart = undefined;
    session.child?.kill("SIGTERM");
    session.child = undefined;
    session.state = "stopped";
  }
  sessions.clear();
}

async function startRunner(udid: string, session: RunnerSession, generation: number): Promise<void> {
  try {
    const artifact = await ensureArtifact(udid);
    if (session.generation !== generation || shuttingDown) return;
    const port = await freePort();
    const configured = await configureXctestrun(artifact.xctestrun, udid, port);
    if (session.generation !== generation || shuttingDown) return;
    const child = spawn("xcodebuild", [
      "test-without-building",
      "-only-testing", "AgentDeviceRunnerUITests/RunnerTests/testCommand",
      "-parallel-testing-enabled", "NO",
      "-test-timeouts-enabled", "NO",
      "-collect-test-diagnostics", "never",
      "-maximum-concurrent-test-simulator-destinations", "1",
      "-destination-timeout", "20",
      "-xctestrun", configured,
      "-derivedDataPath", artifact.derivedData,
      "-destination", `platform=iOS Simulator,id=${udid}`,
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, SERVE_SIM_XCTEST_PORT: String(port) },
    });
    session.child = child;
    session.port = port;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once("exit", (code, signal) => {
      if (session.generation !== generation) return;
      session.child = undefined;
      session.port = undefined;
      session.state = "degraded";
      session.error = stderr.trim() || `xcodebuild exited (${code ?? signal ?? "unknown"})`;
      scheduleRestart(udid, session);
    });
    await waitForReady(port, STARTUP_TIMEOUT_MS);
    if (session.generation !== generation || child.exitCode !== null) return;
    session.state = "ready";
    session.error = undefined;
  } catch (error) {
    if (session.generation !== generation) return;
    session.child?.kill("SIGTERM");
    session.child = undefined;
    session.port = undefined;
    session.state = "degraded";
    session.error = error instanceof Error ? error.message : String(error);
    scheduleRestart(udid, session);
  }
}

async function refreshForeground(udid: string, session: RunnerSession): Promise<string | undefined> {
  const foreground = JSON.parse(await axFrontmostAsync(udid)) as { bundleId?: string };
  session.foregroundBundleId = foreground.bundleId;
  return foreground.bundleId;
}

function degradeAndRestart(udid: string, session: RunnerSession, error: unknown): void {
  session.state = "degraded";
  session.error = error instanceof Error ? error.message : String(error);
  session.generation += 1;
  session.child?.kill("SIGTERM");
  session.child = undefined;
  session.port = undefined;
  scheduleRestart(udid, session);
}

function scheduleRestart(udid: string, session: RunnerSession): void {
  if (shuttingDown || session.restart) return;
  session.restart = setTimeout(() => {
    session.restart = undefined;
    prewarmXCTestRunner(udid);
  }, 1_000);
}

async function ensureArtifact(udid: string): Promise<Artifact> {
  artifactPromise ??= buildOrReuseArtifact(udid).catch((error) => {
    artifactPromise = undefined;
    throw error;
  });
  return artifactPromise;
}

async function buildOrReuseArtifact(udid: string): Promise<Artifact> {
  const project = runnerProjectPath();
  const fingerprint = createHash("sha256")
    .update(spawnSync("xcodebuild", ["-version"], { encoding: "utf8" }).stdout || "")
    .update(hashDirectory(dirname(project)))
    .digest("hex")
    .slice(0, 16);
  const derivedData = join(homedir(), "Library", "Caches", "serve-sim", "xctest", fingerprint);
  const existing = findXctestrun(derivedData);
  if (existing) return { derivedData, xctestrun: existing };
  await mkdir(derivedData, { recursive: true });
  const result = await run("xcodebuild", [
    "-project", project,
    "-scheme", "AgentDeviceRunner",
    "-destination", `platform=iOS Simulator,id=${udid}`,
    "-derivedDataPath", derivedData,
    "build-for-testing",
    "CODE_SIGNING_ALLOWED=NO",
  ], 180_000);
  if (result.code !== 0) {
    await rm(derivedData, { recursive: true, force: true });
    throw new Error(result.stderr.trim() || "Failed to build serve-sim XCTest runner");
  }
  const xctestrun = findXctestrun(derivedData);
  if (!xctestrun) throw new Error("Xcode produced no .xctestrun artifact");
  return { derivedData, xctestrun };
}

function runnerProjectPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../Sources/SimXCTestRunner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj"),
    resolve(moduleDirectory, "../../Sources/SimXCTestRunner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj"),
    resolve(dirname(process.execPath), "../Sources/SimXCTestRunner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj"),
  ];
  const project = candidates.find(existsSync);
  if (!project) throw new Error("serve-sim XCTest runner project is missing");
  return project;
}

function hashDirectory(path: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else {
        hash.update(child.slice(path.length));
        hash.update(readFileSync(child));
      }
    }
  };
  visit(path);
  return hash.digest("hex");
}

function findXctestrun(root: string): string | null {
  if (!existsSync(root)) return null;
  const stack = [root];
  const matches: string[] = [];
  while (stack.length) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith(".xctestrun")) matches.push(path);
    }
  }
  return matches.sort((a, b) => {
    const aCanonical = /\/AgentDeviceRunner_.*\.xctestrun$/.test(a) ? 0 : 1;
    const bCanonical = /\/AgentDeviceRunner_.*\.xctestrun$/.test(b) ? 0 : 1;
    return aCanonical - bCanonical || a.localeCompare(b);
  })[0] ?? null;
}

async function configureXctestrun(source: string, udid: string, port: number): Promise<string> {
  const json = spawnSync("plutil", ["-convert", "json", "-o", "-", source], { encoding: "utf8" });
  if (json.status !== 0) throw new Error(json.stderr || "Failed to read .xctestrun");
  const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
  const merge = (target: Record<string, unknown>) => {
    if (!target.TestBundlePath) return;
    for (const key of ["EnvironmentVariables", "UITestEnvironmentVariables", "UITargetAppEnvironmentVariables", "TestingEnvironmentVariables"]) {
      target[key] = { ...((target[key] as Record<string, string> | undefined) ?? {}), SERVE_SIM_XCTEST_PORT: String(port) };
    }
    target.PreferredScreenCaptureFormat = "screenshots";
    target.SystemAttachmentLifetime = "keepNever";
    target.UserAttachmentLifetime = "keepNever";
  };
  const configurations = parsed.TestConfigurations;
  if (Array.isArray(configurations)) {
    for (const configuration of configurations) {
      if (!configuration || typeof configuration !== "object") continue;
      const targets = (configuration as { TestTargets?: unknown }).TestTargets;
      if (Array.isArray(targets)) {
        for (const target of targets) if (target && typeof target === "object") merge(target as Record<string, unknown>);
      }
    }
  }
  for (const value of Object.values(parsed)) if (value && typeof value === "object" && !Array.isArray(value)) merge(value as Record<string, unknown>);
  const directory = dirname(source);
  await mkdir(directory, { recursive: true });
  const base = join(directory, `${udid}-${port}`);
  const jsonPath = `${base}.json`;
  const output = `${base}.xctestrun`;
  writeFileSync(jsonPath, JSON.stringify(parsed));
  const converted = spawnSync("plutil", ["-convert", "xml1", "-o", output, jsonPath], { encoding: "utf8" });
  await rm(jsonPath, { force: true });
  if (converted.status !== 0) throw new Error(converted.stderr || "Failed to configure .xctestrun");
  return output;
}

async function waitForReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await sendCommand(port, { command: "status" }, 1_000);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out starting XCTest runner");
}

async function sendCommand(port: number, body: Record<string, string>, timeoutMs: number): Promise<RunnerResponse> {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return await response.json() as RunnerResponse;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => stderr += chunk.toString());
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveRun({ code, stderr });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
