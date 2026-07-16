import { describe, expect, test } from "bun:test";
import { cameraArtifactPaths, firstExistingPath, serveSimExecutablePath } from "../binary-paths";

describe("serveSimExecutablePath", () => {
  test("uses the real executable for a compiled Bun entry", () => {
    expect(serveSimExecutablePath(
      ["/opt/serve-sim", "/$bunfs/root/serve-sim"],
      "/opt/serve-sim",
      true,
      (path) => path === "/opt/serve-sim" || path === "/$bunfs/root/serve-sim",
    )).toBe("/opt/serve-sim");
  });

  test("uses the entry script for Node and uncompiled Bun", () => {
    expect(serveSimExecutablePath(
      ["/usr/bin/node", "/opt/serve-sim/dist/serve-sim.js"],
      "/usr/bin/node",
      false,
      (path) => path === "/opt/serve-sim/dist/serve-sim.js",
    )).toBe("/opt/serve-sim/dist/serve-sim.js");
  });
});

test("camera artifacts prefer the directory beside the compiled executable", () => {
  const candidates = cameraArtifactPaths(
    "serve-sim-camera-helper",
    "/$bunfs/root",
    "/opt/serve-sim/dist/serve-sim",
  );

  expect(firstExistingPath(candidates, (path) => path === candidates[0])).toBe(
    "/opt/serve-sim/dist/simcam/serve-sim-camera-helper",
  );
});
