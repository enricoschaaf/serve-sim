import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

export function serveSimExecutablePath(
  argv = process.argv,
  executablePath = process.execPath,
  bunRuntime = typeof process.versions.bun === "string",
  fileExists: (path: string) => boolean = existsSync,
): string {
  const entryPath = argv[1];
  if (entryPath && !entryPath.includes("/$bunfs/") && fileExists(entryPath)) {
    return entryPath;
  }
  if (bunRuntime && fileExists(executablePath)) return executablePath;
  return "serve-sim";
}

export function cameraArtifactPaths(
  filename: string,
  moduleDirectory: string,
  executablePath = process.execPath,
): string[] {
  return [
    join(dirname(executablePath), "simcam", filename),
    join(moduleDirectory, "..", "dist", "simcam", filename),
    join(moduleDirectory, "simcam", filename),
  ];
}

export function firstExistingPath(
  paths: string[],
  fileExists: (path: string) => boolean = existsSync,
): string | null {
  const path = paths.find(fileExists);
  return path ? resolve(path) : null;
}
