# serve-sim CLI reference

Every command and flag agents need for headless simulator automation.
Most subcommands accept `-d <udid|name>` to target a specific simulator.
When omitted, they default to the first running helper.

## Lifecycle

### `serve-sim --detach [device...]` — start a headless helper

Spawns the Swift helper in the background and prints its state as JSON. Idempotent: if a helper for the device is already running, prints the existing state.

```bash
serve-sim --detach
serve-sim --detach "iPhone 16 Pro"
serve-sim --detach 00000000-1111-2222-3333-444444444444
serve-sim --detach -p 3500          # custom starting port
```

Single-device output:
```json
{"url":"http://127.0.0.1:3100","streamUrl":"http://127.0.0.1:3100/stream.mjpeg","wsUrl":"ws://127.0.0.1:3100/ws","port":3100,"device":"<UDID>"}
```

Multi-device output: `{"devices": [ ... ]}`.

### `serve-sim --list [device]` — show running streams

```bash
serve-sim --list
serve-sim --list "iPhone 16 Pro"
```

Shapes:
- `{"running": false}` — no helpers running.
- `{"running": true, "url":..., "port":..., "device":..., "pid":...}` — single helper.
- `{"running": true, "streams": [ ... ]}` — multiple helpers.

### `serve-sim --kill [device]` — stop helpers

Sends SIGTERM to the helper(s) and removes their state file(s).

```bash
serve-sim --kill            # everything
serve-sim --kill "$UDID"    # one device
```

Always returns `{"disconnected": true, ...}` — safe even when nothing is running.

### `serve-sim --no-preview [device...]` — foreground stream

Runs the helper in the foreground (no daemon). Use only when you need to
tail logs in the same terminal; otherwise prefer `--detach`. Blocks until
Ctrl+C; cleans up state on exit.

### `serve-sim` (no args) — `not for agents`

Starts the helper *and* the web preview UI on `:3200`. Blocks indefinitely.
**Avoid in scripts** — agents should use `--detach`.

## Input commands

All input commands take optional `-d <udid|name>` and return immediately
once the WebSocket message is dispatched.

### `serve-sim gesture '<json>' [-d udid]`

Sends one touch event. Coordinates are **normalized to 0..1** (top-left
origin). Build taps and swipes by chaining begin/move/end.

JSON shape:
```json
{"type":"begin"|"move"|"end", "x":0..1, "y":0..1, "edge":0|3}
```

`edge` is optional and only meaningful for system gestures. `3` is the
bottom edge (used for swipe-from-bottom navigation on notch devices).

Tap:
```bash
serve-sim gesture '{"type":"begin","x":0.5,"y":0.5}'
serve-sim gesture '{"type":"end","x":0.5,"y":0.5}'
```

Swipe up:
```bash
serve-sim gesture '{"type":"begin","x":0.5,"y":0.8}'
serve-sim gesture '{"type":"move","x":0.5,"y":0.5}'
serve-sim gesture '{"type":"end","x":0.5,"y":0.2}'
```

Edge swipe to home (bottom edge):
```bash
serve-sim gesture '{"type":"begin","x":0.5,"y":1.0,"edge":3}'
serve-sim gesture '{"type":"move","x":0.5,"y":0.5,"edge":3}'
serve-sim gesture '{"type":"end","x":0.5,"y":0.0,"edge":3}'
```

### `serve-sim button [name] [-d udid]`

Press a hardware button. Default is `home`.

```bash
serve-sim button            # home
serve-sim button home
```

### `serve-sim rotate <orientation> [-d udid]`

Set device orientation. Allowed values:
- `portrait`
- `portrait_upside_down`
- `landscape_left`
- `landscape_right`

```bash
serve-sim rotate landscape_left
```

Re-fetch `/config` afterwards: width/height swap under landscape.

### `serve-sim ca-debug <option> <on|off> [-d udid]`

Toggle a CoreAnimation debug overlay (same as `Simulator.app`'s Debug
menu). Option shortcuts:

| Shortcut | Underlying option |
|---|---|
| `blended` | `debug_color_blended` |
| `copies` | `debug_color_copies` |
| `misaligned` | `debug_color_misaligned` |
| `offscreen` | `debug_color_offscreen` |
| `slow-animations` | `debug_slow_animations` |

```bash
serve-sim ca-debug slow-animations on
serve-sim ca-debug blended on
serve-sim ca-debug blended off
```

### `serve-sim memory-warning [-d udid]`

Triggers `-[SimDevice simulateMemoryWarning]` on the device.

```bash
serve-sim memory-warning
```

## Helper HTTP endpoints

Once `--detach` is up, the helper exposes a small HTTP API on its port.
These are not subcommands of `serve-sim` — call them with `curl`. Get the
port from `serve-sim --list`.

| Endpoint | Method | Returns |
|---|---|---|
| `/health` | GET | `{"status":"ok"}` once the helper is ready |
| `/config` | GET | `{"width":<px>,"height":<px>,"orientation":"..."}` |
| `/ax` | GET | Raw accessibility tree (flat array of `AXNode` objects). 503 with `{"error":"ax_unavailable"}` when AX is not currently usable. |
| `/stream.mjpeg` | GET | Continuous MJPEG video stream. Pipe to `ffmpeg` for capture. |
| `/ws` | WebSocket | Binary input protocol (CLI commands wrap this — agents normally do not need to speak it directly). |

Each `AXNode` looks like:
```json
{
  "AXUniqueId": "SignInButton" | null,
  "AXLabel":    "Sign In"      | null,
  "AXValue":    "..."          | null,
  "enabled":    true,
  "frame":      {"x":120,"y":640,"width":150,"height":48},
  "type":       "Button",
  "role_description": "button",
  "children":   [...]
}
```

`frame` is in **pixels**. Divide by `/config`'s `width` / `height` to get
the normalized coordinates `gesture` wants.

## Verification commands (not part of serve-sim)

These are standard tools that live alongside `serve-sim` and play well
with the helper.

```bash
xcrun simctl io "$UDID" screenshot post.png      # PNG screenshot
xcrun simctl io "$UDID" recordVideo run.mp4      # video (Ctrl+C to stop)
xcrun simctl listapps "$UDID"                    # installed apps
xcrun simctl launch  "$UDID" com.example.app
xcrun simctl terminate "$UDID" com.example.app
```

The `serve-sim` helper does not lock the framebuffer, so `simctl io` runs
in parallel with the live MJPEG stream.

## Global flags

| Flag | Purpose |
|---|---|
| `-p, --port <port>` | Starting port (preview default 3200, stream default 3100). On collision the CLI scans forward unless `--port` was set explicitly. |
| `-d, --detach` | Daemon mode (see `--detach` above). |
| `-q, --quiet` | Suppress human-readable output, JSON only. |
| `--no-preview` | Run helper in foreground without the web UI. |
| `--list [device]` | List running streams. |
| `--kill [device]` | Stop running helpers. |
| `-h, --help` | Print help. |

## State on disk

Helpers write a JSON state file per device under `$TMPDIR/serve-sim/`.
The CLI reads these files for `--list`, `--kill`, and the implicit-target
shortcut on input commands. Stale entries (helper PID gone or device no
longer booted) are pruned automatically on the next CLI call.
