---
name: serve-sim
description: Drive a booted iOS Simulator headlessly with the `serve-sim` CLI. Use when asked to automate a simulator, tap/swipe/scroll, inspect UI/accessibility, send hardware buttons, change orientation, simulate a memory warning, toggle CoreAnimation debug flags, take a screenshot, or run any agent-style flow against an iOS Simulator without opening the preview UI.
---

## When to use

Use this skill when an agent needs to interact with an iOS, iPadOS, watchOS, or
tvOS Simulator from a CLI — without opening the `serve-sim` browser preview.
`serve-sim` ships a small Swift helper that drives the simulator's HID and
accessibility surfaces (the same private APIs `Simulator.app` uses), and the
`serve-sim` CLI exposes them as discrete subcommands plus a JSON state file.

The headless loop is:

```
ensure helper running  →  inspect (/ax)  →  send input (gesture/button/rotate)
                                                       ↓
                                                  verify (screenshot or /ax)
```

## Step 1 — Confirm a helper is running

`serve-sim` runs **per device**: every booted simulator gets its own helper
process, port, and state file. Always check what is already running before
starting anything.

```bash
serve-sim --list
```

Output is JSON. Three shapes you should branch on:

- `{"running": false}` — nothing is up. Start one (Step 2).
- `{"running": true, "device": "<UDID>", "port": <int>, ...}` — a single
  helper. Use its `device` UDID and `port` for everything below.
- `{"running": true, "streams": [ ... ]}` — multiple helpers. Pick the entry
  whose `device` matches the user's intent (or filter by name with
  `serve-sim --list "iPhone 16 Pro"`).

Capture the UDID and port; almost every following command needs them:

```bash
STATE=$(serve-sim --list)
UDID=$(echo "$STATE" | jq -r '.device // .streams[0].device')
PORT=$(echo "$STATE" | jq -r '.port  // .streams[0].port')
```

## Step 2 — Start a helper headlessly when needed

For agent flows you almost always want **`--detach`** (daemon mode). It spawns
the helper in the background, prints its state as JSON, and exits. No browser
preview, no foreground process to babysit.

```bash
# Pick the booted device automatically (or boot an iPhone if none is booted)
serve-sim --detach

# Target a specific device by name or UDID
serve-sim --detach "iPhone 16 Pro"
serve-sim --detach 00000000-1111-2222-3333-444444444444
```

Avoid the bare `serve-sim` form in agent contexts — it tries to start the web
preview and **blocks**. `--no-preview` is the foreground equivalent if you
specifically need to tail logs in the same shell, but for automation always
prefer `--detach` and read state with `--list`.

If a helper for the requested device is already running, `--detach` is a
no-op and re-prints the existing state. Safe to call as a setup step.

## Step 3 — Inspect the UI before tapping

The helper exposes the simulator's accessibility tree at
`http://127.0.0.1:<PORT>/ax`. This is the same data Apple's accessibility
inspector and `axe describe-ui` see. Always read it before sending taps so
you can pick a stable target instead of guessing pixels.

```bash
curl -s http://127.0.0.1:$PORT/ax | jq .
```

Each node has `AXUniqueId`, `AXLabel`, `AXValue`, `enabled`, `frame`
(`{x, y, width, height}` in **pixel** coordinates), `type`, and `children`.
Find a target by label and grab its centre frame:

```bash
curl -s http://127.0.0.1:$PORT/ax \
  | jq '[.. | objects | select(.AXLabel == "Sign In") | .frame] | .[0]'
```

The screen size is at `/config` (use it to convert pixels → normalized 0..1
coordinates that the `gesture` command needs):

```bash
curl -s http://127.0.0.1:$PORT/config
# {"width":393,"height":852,"orientation":"portrait"}
```

If `/ax` returns HTTP 503 with `ax_unavailable`, accessibility is not
available on this simulator (framework missing, SpringBoard restarting,
device just booting). Wait a few seconds, retry, or fall back to
coordinate-based taps.

See `references/automation-recipes.md` for the standard "find element by
label → tap its centre" snippet.

## Step 4 — Send input with the CLI

The CLI is **primitive on purpose**: each subcommand sends one event over
the helper's WebSocket. Build taps and swipes from `gesture`
begin/move/end. All `-d <udid>` flags are optional — when omitted, the
command targets the first running helper.

### Tap (single touch)

`gesture` takes JSON with normalized 0..1 coordinates. A tap is a
`begin` followed immediately by an `end` at the same point:

```bash
serve-sim gesture '{"type":"begin","x":0.5,"y":0.45}' -d "$UDID"
serve-sim gesture '{"type":"end","x":0.5,"y":0.45}'   -d "$UDID"
```

### Swipe / scroll

A swipe is `begin` → one or more `move` → `end`. For a vertical scroll
that moves content up the screen (i.e. shows what is below):

```bash
serve-sim gesture '{"type":"begin","x":0.5,"y":0.8}' -d "$UDID"
serve-sim gesture '{"type":"move","x":0.5,"y":0.5}'  -d "$UDID"
serve-sim gesture '{"type":"end","x":0.5,"y":0.2}'   -d "$UDID"
```

For an edge-initiated swipe (e.g. swipe-up-from-bottom on a notch device
to go home), include the `edge` field. `3` is the bottom edge:

```bash
serve-sim gesture '{"type":"begin","x":0.5,"y":1.0,"edge":3}' -d "$UDID"
serve-sim gesture '{"type":"move", "x":0.5,"y":0.5,"edge":3}' -d "$UDID"
serve-sim gesture '{"type":"end",  "x":0.5,"y":0.0,"edge":3}' -d "$UDID"
```

Tip: prefer `serve-sim button home` over the edge-swipe trick when you
just want to leave the foreground app — it works on every device class.

### Hardware buttons

```bash
serve-sim button home -d "$UDID"
serve-sim button -d "$UDID"          # default is "home"
```

Only `home` is wired through the public CLI today; other hardware events
go via the private WebSocket protocol.

### Rotate

```bash
serve-sim rotate portrait              -d "$UDID"
serve-sim rotate portrait_upside_down  -d "$UDID"
serve-sim rotate landscape_left        -d "$UDID"
serve-sim rotate landscape_right       -d "$UDID"
```

Re-fetch `/config` afterwards if you cached the screen size — width and
height swap under landscape.

### CoreAnimation debug overlays

These are the same toggles as `Simulator.app`'s **Debug → Color/Slow Animations**
menu. Useful for visual debugging in screenshots and CI artifacts.

```bash
serve-sim ca-debug slow-animations on  -d "$UDID"
serve-sim ca-debug blended            on  -d "$UDID"
serve-sim ca-debug copies             on  -d "$UDID"
serve-sim ca-debug misaligned         on  -d "$UDID"
serve-sim ca-debug offscreen          on  -d "$UDID"
serve-sim ca-debug slow-animations off -d "$UDID"
```

### Memory warning

```bash
serve-sim memory-warning -d "$UDID"
```

Fires `-[SimDevice simulateMemoryWarning]`. Useful for verifying
foreground-app memory handlers without provoking the OS killer.

## Step 5 — Verify the outcome

Input commands are **fire-and-forget**: they confirm the WebSocket message
was sent, not that the app reacted. Always verify visible state.

```bash
# Re-read the AX tree (same path-find pattern as Step 3)
curl -s http://127.0.0.1:$PORT/ax | jq '[.. | objects | select(.AXLabel?) | .AXLabel]'

# Or grab a PNG screenshot via simctl (no extra tooling required)
xcrun simctl io "$UDID" screenshot post.png
```

`serve-sim` itself does not ship a `screenshot` subcommand — `simctl io`
is the supported path, and the `serve-sim` helper does not interfere with
it. For frame-by-frame capture during automation, point any HTTP client
at the helper's `/stream.mjpeg` endpoint instead.

## Step 6 — Clean up

When the agent is done, stop the helpers it started:

```bash
serve-sim --kill              # all running helpers
serve-sim --kill "$UDID"      # just one device
```

`--kill` returns JSON (`{"disconnected": true, ...}`) and is idempotent —
safe to call even if nothing was running.

## Common pitfalls

- **Pixel vs normalized coordinates.** `/ax` returns pixel frames;
  `gesture` wants normalized 0..1. Always divide by `/config`'s width
  and height. See `references/automation-recipes.md`.
- **Don't run `serve-sim` (no flags) in an agent.** That path opens the
  web preview and blocks indefinitely. Use `--detach`.
- **AX is best-effort.** Wait a beat after launching a fresh app — the
  accessibility framework needs a moment to populate. Retry on 503.
- **Multiple booted simulators.** Always pass `-d <udid>` once more than
  one helper is up; the default-target shortcut only works for a single
  device.
- **State files live under `$TMPDIR/serve-sim/`.** Stale entries are
  cleaned automatically on the next `--list`/`--kill`/`--detach`, so a
  killed-then-restarted helper is fine.

## References

- `references/cli-reference.md` — every subcommand and flag, with examples.
- `references/automation-recipes.md` — copy-paste recipes for tap-by-label,
  scroll, swipe, ax-driven flows, and verification.
