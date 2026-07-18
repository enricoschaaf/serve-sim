import { execFile } from "child_process";

export type ForegroundApp = { bundleId: string; pid?: number };

const NON_UI_BUNDLE_RE = /(WidgetRenderer|ExtensionHost|\.extension(\.|$)|Service|PlaceholderApp|InCallService|CallUI|InCallUI|com\.apple\.Preferences\.Cellular|com\.apple\.purplebuddy|com\.apple\.chrono|com\.apple\.shuttle|com\.apple\.usernotificationsui|\.xctrunner$)/i;
export const foregroundLogPredicate =
  'process == "SpringBoard" AND (eventMessage CONTAINS "Setting process visibility to: Foreground" OR eventMessage CONTAINS "Front display did change:")';

export function isUserFacingBundle(bundleId: string): boolean {
  return !NON_UI_BUNDLE_RE.test(bundleId);
}

export function parseForegroundAppLogMessage(message: string): ForegroundApp | null {
  const visibility = /\[app<([^>]+)>:(\d+)\] Setting process visibility to: Foreground/.exec(message);
  if (visibility) {
    return { bundleId: visibility[1]!, pid: parseInt(visibility[2]!, 10) };
  }
  const frontDisplay = /Front display did change: <SBApplication: [^;>]+;\s*([^>\s]+)>/.exec(message);
  return frontDisplay ? { bundleId: frontDisplay[1]! } : null;
}

export function latestForegroundAppFromLogs(
  udid: string,
  lookback = "30m",
): Promise<ForegroundApp | null> {
  return new Promise((resolve) => {
    execFile(
      "xcrun",
      [
        "simctl", "spawn", udid, "log", "show",
        "--last", lookback,
        "--style", "ndjson",
        "--predicate", foregroundLogPredicate,
      ],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (_error, stdout) => {
        let latest: ForegroundApp | null = null;
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const message = (JSON.parse(line) as { eventMessage?: unknown }).eventMessage;
            if (typeof message !== "string") continue;
            const event = parseForegroundAppLogMessage(message);
            if (event && isUserFacingBundle(event.bundleId)) latest = event;
          } catch {}
        }
        resolve(latest);
      },
    );
  });
}
