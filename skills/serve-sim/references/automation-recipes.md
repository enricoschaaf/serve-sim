# serve-sim automation recipes

Copy-paste shell snippets for common headless flows. Every recipe assumes:

- A simulator is already booted (or `serve-sim --detach` will boot one).
- `jq` is on `$PATH` (any agent running on macOS dev machines should have it
  via Homebrew; install with `brew install jq` if missing).

Each recipe is self-contained. Run them in order or paste into a script.

## 0. Bootstrap — always start here

```bash
# Idempotent: starts the helper if needed, no-ops otherwise.
serve-sim --detach >/dev/null

STATE=$(serve-sim --list)
UDID=$(echo "$STATE" | jq -r '.device // .streams[0].device')
PORT=$(echo "$STATE" | jq -r '.port  // .streams[0].port')
test -n "$UDID" && test "$UDID" != "null" || { echo "no helper running"; exit 1; }

# Cache the screen size — needed to convert pixel frames to normalized 0..1.
read W H ORIENTATION <<<"$(curl -s http://127.0.0.1:$PORT/config \
  | jq -r '"\(.width) \(.height) \(.orientation)"')"
echo "device=$UDID port=$PORT screen=${W}x${H} orientation=$ORIENTATION"
```

Re-run the `read W H ...` line after a `serve-sim rotate` — width and
height swap under landscape.

## 1. Tap by accessibility label

```bash
LABEL='Sign In'
FRAME=$(curl -s "http://127.0.0.1:$PORT/ax" \
  | jq --arg L "$LABEL" '[.. | objects | select(.AXLabel == $L) | .frame] | .[0]')

if [ "$FRAME" = "null" ] || [ -z "$FRAME" ]; then
  echo "no element with label \"$LABEL\""
  exit 1
fi

NX=$(jq -n --argjson f "$FRAME" --argjson w "$W" '($f.x + $f.width  / 2) / $w')
NY=$(jq -n --argjson f "$FRAME" --argjson h "$H" '($f.y + $f.height / 2) / $h')

serve-sim gesture "{\"type\":\"begin\",\"x\":$NX,\"y\":$NY}" -d "$UDID"
serve-sim gesture "{\"type\":\"end\",  \"x\":$NX,\"y\":$NY}" -d "$UDID"
```

Prefer `AXUniqueId` over `AXLabel` when the app exposes one — labels are
localized and can be ambiguous. Swap the `select(...)` clause:
`select(.AXUniqueId == $ID)`.

## 2. Tap a specific point (no AX lookup)

```bash
# Centre of the screen.
serve-sim gesture '{"type":"begin","x":0.5,"y":0.5}' -d "$UDID"
serve-sim gesture '{"type":"end","x":0.5,"y":0.5}'   -d "$UDID"
```

## 3. Vertical scroll (content moves up)

```bash
serve-sim gesture '{"type":"begin","x":0.5,"y":0.80}' -d "$UDID"
serve-sim gesture '{"type":"move","x":0.5,"y":0.50}' -d "$UDID"
serve-sim gesture '{"type":"move","x":0.5,"y":0.30}' -d "$UDID"
serve-sim gesture '{"type":"end", "x":0.5,"y":0.20}' -d "$UDID"
```

More `move` events between `begin` and `end` produce a slower, more
controlled drag. Three to five intermediate points feels natural to most
gesture recognizers.

## 4. Horizontal swipe (e.g. dismiss a card)

```bash
serve-sim gesture '{"type":"begin","x":0.10,"y":0.50}' -d "$UDID"
serve-sim gesture '{"type":"move","x":0.50,"y":0.50}' -d "$UDID"
serve-sim gesture '{"type":"end", "x":0.90,"y":0.50}' -d "$UDID"
```

## 5. Go home

```bash
# Works on every device class.
serve-sim button home -d "$UDID"

# Equivalent on notch devices via edge swipe (avoid unless you specifically
# want to exercise the gesture system).
serve-sim gesture '{"type":"begin","x":0.5,"y":1.0,"edge":3}' -d "$UDID"
serve-sim gesture '{"type":"move", "x":0.5,"y":0.5,"edge":3}' -d "$UDID"
serve-sim gesture '{"type":"end",  "x":0.5,"y":0.0,"edge":3}' -d "$UDID"
```

## 6. Wait for an element to appear

`serve-sim` does not have built-in waiting. Roll your own poll loop on
`/ax`:

```bash
wait_for_label() {
  local label=$1 timeout=${2:-10}
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -s "http://127.0.0.1:$PORT/ax" \
        | jq -e --arg L "$label" 'any(.. | objects; .AXLabel == $L)' >/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

wait_for_label 'Welcome' 10 || { echo "Welcome never appeared"; exit 1; }
```

Use the same shape with `.AXUniqueId == $ID` for stable IDs.

## 7. Verify after every action

```bash
# Snapshot the screen.
xcrun simctl io "$UDID" screenshot "/tmp/serve-sim-step-$(date +%s).png"

# Or grab the labels currently visible.
curl -s "http://127.0.0.1:$PORT/ax" \
  | jq '[.. | objects | select(.AXLabel?) | .AXLabel] | unique'
```

## 8. Rotate, then re-cache the screen size

```bash
serve-sim rotate landscape_left -d "$UDID"
sleep 0.5    # let CoreAnimation settle
read W H ORIENTATION <<<"$(curl -s http://127.0.0.1:$PORT/config \
  | jq -r '"\(.width) \(.height) \(.orientation)"')"
```

## 9. Toggle visual debug overlays for a screenshot

```bash
serve-sim ca-debug blended on  -d "$UDID"
serve-sim ca-debug copies  on  -d "$UDID"
xcrun simctl io "$UDID" screenshot blended-overlay.png
serve-sim ca-debug blended off -d "$UDID"
serve-sim ca-debug copies  off -d "$UDID"
```

## 10. Multi-device fanout

```bash
# Boot two helpers at once.
serve-sim --detach "iPhone 16 Pro" "iPad Air 11-inch"

# Loop over them.
for entry in $(serve-sim --list | jq -c '.streams // [.] | .[]'); do
  udid=$(echo "$entry" | jq -r .device)
  port=$(echo "$entry" | jq -r .port)
  echo "→ $udid (port $port)"
  serve-sim button home -d "$udid"
done
```

## 11. Tear down at the end of the run

```bash
serve-sim --kill >/dev/null
```

`--kill` is idempotent. Always include it in a `trap` so a failed agent
run does not leave helpers around:

```bash
trap 'serve-sim --kill >/dev/null 2>&1' EXIT
```

## Patterns to avoid

- **Looping `serve-sim` (no flags) inside a script.** It blocks on the
  preview server. Always use `--detach`.
- **Computing taps from screenshot pixels.** Screenshots have a different
  scale than the AX frame coordinates (Retina). Use `/config` width/height,
  not the PNG dimensions.
- **Ignoring 503 from `/ax`.** A freshly booted simulator can take a few
  seconds before the accessibility framework is ready. Retry with backoff;
  do not fall through to coordinate taps unless you have to.
- **Sending `move` without `begin`.** All swipes must start with a `begin`
  at the same point as the first `move`. Without `begin` the helper drops
  the event.
