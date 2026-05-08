import { describe, expect, test } from "bun:test";
import { parseMetroJsTargets } from "../middleware";

const FRONTEND_BASE = "/.sim/devtools-frontend";
const REQ_HOST = "192.168.1.5:8081";

describe("parseMetroJsTargets", () => {
  test("converts Metro CDP entries into picker targets", () => {
    const targets = parseMetroJsTargets(
      [
        {
          id: "0-1",
          title: "Hermes React Native",
          appId: "com.example.app",
          deviceName: "iPhone 15 Pro",
          type: "node",
          webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=A&page=1",
          reactNative: { logicalDeviceId: "abc" },
        },
      ],
      REQ_HOST,
      FRONTEND_BASE,
    );

    expect(targets).toHaveLength(1);
    const [t] = targets;
    expect(t.id).toBe("metro:0-1");
    expect(t.title).toBe("Hermes React Native");
    expect(t.type).toBe("node");
    expect(t.bundleId).toBe("com.example.app");
    expect(t.appName).toBe("iPhone 15 Pro");
    // Host gets rewritten to the request host so LAN visitors don't hit `localhost`.
    expect(t.webSocketDebuggerUrl).toBe(
      `ws://${REQ_HOST}/inspector/debug?device=A&page=1`,
    );
    // Frontend URL points at the same-origin proxy with the rewritten WS value.
    expect(t.devtoolsFrontendUrl.startsWith(`${FRONTEND_BASE}/inspector.html?ws=`)).toBe(true);
    const wsParam = new URL(t.devtoolsFrontendUrl, "http://x").searchParams.get("ws");
    expect(wsParam).toBe(`${REQ_HOST}/inspector/debug?device=A&page=1`);
  });

  test("falls back to 'React Native' / 'JS debugger' when device/title missing", () => {
    const [t] = parseMetroJsTargets(
      [
        {
          id: "0-2",
          appId: "com.example.app",
          webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=A&page=2",
        },
      ],
      REQ_HOST,
      FRONTEND_BASE,
    );
    expect(t.appName).toBe("React Native");
    expect(t.title).toBe("JS debugger");
  });

  test("filters out non-RN / non-debuggable entries", () => {
    const targets = parseMetroJsTargets(
      [
        // Missing WS URL → drop.
        { id: "no-ws", appId: "com.example.app" },
        // Non-RN browser-style entry → drop (no appId, no reactNative).
        {
          id: "browser",
          type: "page",
          webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?page=x",
        },
        // Unknown type → drop.
        {
          id: "worker",
          type: "service_worker",
          appId: "com.example.app",
          webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?page=x",
        },
        // Malformed WS URL → drop.
        {
          id: "bad",
          appId: "com.example.app",
          webSocketDebuggerUrl: "not-a-url",
        },
      ],
      REQ_HOST,
      FRONTEND_BASE,
    );
    expect(targets).toEqual([]);
  });

  test("returns [] for non-array input", () => {
    expect(parseMetroJsTargets(null, REQ_HOST, FRONTEND_BASE)).toEqual([]);
    expect(parseMetroJsTargets({}, REQ_HOST, FRONTEND_BASE)).toEqual([]);
    expect(parseMetroJsTargets("nope" as unknown, REQ_HOST, FRONTEND_BASE)).toEqual([]);
  });
});
