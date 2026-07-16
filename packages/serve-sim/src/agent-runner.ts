export type AgentAdapter = {
  describe(): Promise<{ tree: unknown; frameGeneration: number }>;
  screenshot(): Buffer | null;
  tap(x: number, y: number): Promise<void>;
  swipe(from: [number, number], to: [number, number], durationMs: number): Promise<void>;
  scroll(dx: number, dy: number, x?: number, y?: number): Promise<void>;
  multiTouch(from: [number, number, number, number], to: [number, number, number, number], durationMs: number): Promise<void>;
  type(text: string): Promise<void>;
  button(name: string): Promise<void>;
  settle(since: number, quietMs: number, timeoutMs: number): Promise<void>;
};

export type AgentRunnerState = {
  generation: number;
  snapshot?: Snapshot;
};

type Frame = { x: number; y: number; width: number; height: number };
type Element = {
  ref?: string;
  id: string;
  path: string;
  parentPath?: string;
  label: string;
  value: string;
  role: string;
  type: string;
  enabled: boolean;
  visible: boolean;
  actionable: boolean;
  blocked: boolean;
  frame: Frame;
};
type Snapshot = {
  generation: number;
  frameGeneration: number;
  width: number;
  height: number;
  elements: Element[];
};
type Selector = {
  ref?: string;
  id?: string;
  label?: string;
  text?: string;
  value?: string;
  role?: string;
  type?: string;
};
type SnapshotOptions = { interactive?: boolean; all?: boolean };
type StepTiming = { step: number; durationMs: number };

export type AgentRunResult =
  | { ok: true; completed: number; snapshot: string; screenshot?: string }
  | {
      ok: false;
      completed: number;
      failedStep: number;
      error: string;
      snapshot: string;
      screenshot?: string;
      timings: StepTiming[];
    };

const ACTIONS = ["tap", "swipe", "scroll", "multiTouch", "type", "button", "wait", "snapshot", "screenshot"] as const;
const POLL_MS = 100;
const REF_REMAP_MAX_DISTANCE = 80;
const REF_REMAP_MIN_MARGIN = 20;

export async function runAgentBatch(
  adapter: AgentAdapter,
  operations: unknown,
  state: AgentRunnerState = { generation: 0 },
): Promise<AgentRunResult> {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 100) {
    throw new Error("operations must be an array containing 1 to 100 steps");
  }
  let snapshotOptions: SnapshotOptions = {};
  let includeScreenshot = false;
  const timings: StepTiming[] = [];
  let current: Snapshot | undefined;

  for (let step = 0; step < operations.length; step++) {
    const started = performance.now();
    try {
      const operation = object(operations[step], `operation ${step}`);
      const action = ACTIONS.filter((name) => operation[name] !== undefined);
      if (action.length !== 1) throw new Error(`operation ${step} must contain exactly one action`);
      const name = action[0]!;
      const executed = await execute(adapter, state, name, operation[name], operation.until, current);
      current = executed.current;
      if (name === "snapshot") snapshotOptions = snapshotOperation(operation[name]);
      if (name === "screenshot") includeScreenshot = true;
      if (operation.until !== undefined) {
        if (["wait", "snapshot", "screenshot"].includes(name)) {
          throw new Error(`${name} cannot include until`);
        }
        current = await waitForCondition(adapter, operation.until, executed.before, state);
      }
      timings.push({ step, durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      timings.push({ step, durationMs: Math.round(performance.now() - started) });
      const snapshot = await publish(adapter, state);
      const screenshot = adapter.screenshot();
      return {
        ok: false,
        completed: step,
        failedStep: step,
        error: error instanceof Error ? error.message : String(error),
        snapshot: formatSnapshot(snapshot, snapshotOptions),
        ...(screenshot ? { screenshot: screenshot.toString("base64") } : {}),
        timings,
      };
    }
  }

  const snapshot = await publish(adapter, state, current);
  return {
    ok: true,
    completed: operations.length,
    snapshot: formatSnapshot(snapshot, snapshotOptions),
    ...(includeScreenshot && adapter.screenshot()
      ? { screenshot: adapter.screenshot()!.toString("base64") }
      : {}),
  };
}

async function execute(
  adapter: AgentAdapter,
  state: AgentRunnerState,
  name: typeof ACTIONS[number],
  raw: unknown,
  until: unknown,
  current?: Snapshot,
): Promise<{
  before: { frameGeneration: number; conditionPresent: boolean };
  current?: Snapshot;
}> {
  if (name === "snapshot" || name === "screenshot") {
    object(raw, name);
    return { before: { frameGeneration: 0, conditionPresent: false }, current };
  }
  if (name === "wait") {
    const matched = await waitForCondition(
      adapter,
      raw,
      { frameGeneration: 0, conditionPresent: false },
      state,
    );
    return { before: { frameGeneration: 0, conditionPresent: false }, current: matched };
  }

  const snapshot = current ?? await capture(adapter);
  const conditionPresent = until === undefined ? false : matchesCondition(snapshot, until, state);
  if (name === "tap") {
    const action = object(raw, "tap");
    const [x, y] = coordinates(action) ?? normalizedCenter(resolveSelector(snapshot, selector(action), state), snapshot);
    validateCoordinates([x, y]);
    await adapter.tap(x, y);
  } else if (name === "swipe") {
    const action = object(raw, "swipe");
    const from = point(action.from, "swipe.from");
    const to = point(action.to, "swipe.to");
    const durationMs = positiveDuration(action.durationMs, 300);
    await adapter.swipe(from, to, durationMs);
  } else if (name === "scroll") {
    const action = object(raw, "scroll");
    const dx = finiteNumber(action.dx, "scroll.dx");
    const dy = finiteNumber(action.dy, "scroll.dy");
    const anchor = action.at === undefined ? undefined : point(action.at, "scroll.at");
    await adapter.scroll(dx, dy, anchor?.[0], anchor?.[1]);
  } else if (name === "multiTouch") {
    const action = object(raw, "multiTouch");
    const from = touchPair(action.from, "multiTouch.from");
    const to = touchPair(action.to, "multiTouch.to");
    await adapter.multiTouch(from, to, positiveDuration(action.durationMs, 300));
  } else if (name === "type") {
    const action = object(raw, "type");
    if (typeof action.text !== "string") throw new Error("type.text must be a string");
    await adapter.type(action.text);
  } else if (name === "button") {
    const action = object(raw, "button");
    if (typeof action.name !== "string" || !action.name) throw new Error("button.name must be a string");
    await adapter.button(action.name);
  }
  return {
    before: { frameGeneration: snapshot.frameGeneration, conditionPresent },
  };
}

async function waitForCondition(
  adapter: AgentAdapter,
  raw: unknown,
  before: { frameGeneration: number; conditionPresent: boolean },
  state: AgentRunnerState,
): Promise<Snapshot | undefined> {
  const condition = object(raw, "wait condition");
  const timeoutMs = positiveDuration(condition.timeoutMs, 5_000);
  if (condition.stable === true) {
    await adapter.settle(before.frameGeneration, positiveDuration(condition.quietMs, 500), timeoutMs);
    return undefined;
  }
  const target = selector(condition);
  const started = performance.now();
  while (true) {
    const snapshot = await capture(adapter);
    const changed = before.frameGeneration === 0 || snapshot.frameGeneration > before.frameGeneration;
    if (findWithState(snapshot, target, state).length === 1 && (!before.conditionPresent || changed)) {
      return snapshot;
    }
    if (performance.now() - started >= timeoutMs) {
      throw new Error(`timed out waiting for ${JSON.stringify(target)}`);
    }
    await delay(POLL_MS);
  }
}

function matchesCondition(snapshot: Snapshot, raw: unknown, state: AgentRunnerState): boolean {
  const condition = object(raw, "until");
  return condition.stable === true ? false : findWithState(snapshot, selector(condition), state).length > 0;
}

async function publish(adapter: AgentAdapter, state: AgentRunnerState, current?: Snapshot): Promise<Snapshot> {
  const snapshot = current ?? await capture(adapter);
  snapshot.generation = ++state.generation;
  let index = 1;
  for (const element of snapshot.elements) {
    if (element.visible && element.enabled && element.actionable && !element.blocked) {
      element.ref = `e${index++}`;
    }
  }
  state.snapshot = snapshot;
  return snapshot;
}

async function capture(adapter: AgentAdapter): Promise<Snapshot> {
  const description = await adapter.describe();
  const roots = Array.isArray(description.tree) ? description.tree : [];
  const root = object(roots[0], "accessibility root");
  const screen = frame(root.frame, "accessibility root frame");
  const elements: Element[] = [];
  roots.forEach((node, index) => flatten(node, String(index), undefined, [], screen, elements));
  applyOcclusion(elements, screen);
  return {
    generation: 0,
    frameGeneration: description.frameGeneration,
    width: screen.width,
    height: screen.height,
    elements,
  };
}

function flatten(
  raw: unknown,
  path: string,
  parentPath: string | undefined,
  ancestorTypes: string[],
  screen: Frame,
  elements: Element[],
): void {
  if (elements.length >= 500) return;
  const node = object(raw, `accessibility node ${path}`);
  const nodeFrame = node.frame === undefined ? screen : frame(node.frame, `frame ${path}`);
  const type = string(node.type);
  if (!sameFrame(nodeFrame, screen)) {
    const label = string(node.AXLabel);
    const role = string(node.role_description);
    const id = string(node.AXUniqueId) || path;
    const enabled = node.enabled !== false;
    elements.push({
      id,
      path,
      parentPath,
      label,
      value: string(node.AXValue),
      role,
      type,
      enabled,
      visible: visible(nodeFrame, screen),
      actionable: enabled && (
        actionable(role, type, id, path, label)
        || implicitRowActionable(type, label, nodeFrame, ancestorTypes, screen.width)
      ),
      blocked: false,
      frame: nodeFrame,
    });
  }
  if (Array.isArray(node.children)) {
    const childAncestors = [...ancestorTypes, type];
    node.children.forEach((child, index) =>
      flatten(child, `${path}.${index}`, path, childAncestors, screen, elements)
    );
  }
}

function applyOcclusion(elements: Element[], screen: Frame): void {
  let overlayIndex = -1;
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]!;
    const semantic = `${element.role} ${element.type} ${element.label}`.toLowerCase();
    if (["sheet", "dialog", "alert", "popover", "menu"].some((value) => semantic.includes(value))
      && element.frame.width * element.frame.height >= screen.width * screen.height * 0.1) {
      overlayIndex = index;
      break;
    }
  }
  if (overlayIndex < 0) return;
  const overlay = elements[overlayIndex]!.frame;
  const overlayPath = elements[overlayIndex]!.path;
  for (let index = 0; index < overlayIndex; index++) {
    const element = elements[index]!;
    const belongsToOverlay = element.path === overlayPath
      || element.path.startsWith(`${overlayPath}.`)
      || overlayPath.startsWith(`${element.path}.`);
    if (!belongsToOverlay && inside(frameCenter(element.frame), overlay)) element.blocked = true;
  }
}

function selector(raw: Record<string, unknown>): Selector {
  const values = Object.fromEntries(
    ["ref", "id", "label", "text", "value", "role", "type"]
      .filter((key) => raw[key] !== undefined)
      .map((key) => [key, raw[key]]),
  ) as Selector;
  const entries = Object.entries(values);
  if (entries.length !== 1 || typeof entries[0]![1] !== "string" || !entries[0]![1]) {
    throw new Error("selector must contain exactly one non-empty ref, id, label, text, value, role, or type");
  }
  return values;
}

function resolveSelector(snapshot: Snapshot, target: Selector, state: AgentRunnerState): Element {
  if (target.ref) {
    const matches = remapReference(snapshot, target.ref, state);
    if (matches.length === 1) return actionableElement(matches[0]!, target);
    throw new Error(`stale snapshot ref ${JSON.stringify(target.ref)} could not be resolved uniquely`);
  }
  const matches = find(snapshot, target);
  const actionable = matches.filter((element) => element.actionable);
  if (actionable.length === 1) return actionableElement(actionable[0]!, target);
  if (actionable.length > 1) {
    throw new Error(`${JSON.stringify(target)} matched ${actionable.length} actionable elements`);
  }
  const nearest = [...new Set(
    matches
      .map((element) => nearestActionable(snapshot, element))
      .filter((element): element is Element => element !== undefined),
  )];
  if (nearest.length === 1) return actionableElement(nearest[0]!, target);
  if (nearest.length > 1) {
    throw new Error(`${JSON.stringify(target)} maps to ${nearest.length} actionable elements`);
  }
  if (matches.length === 1) return actionableElement(matches[0]!, target);
  throw new Error(`${JSON.stringify(target)} matched ${matches.length} elements`);
}

function findWithState(snapshot: Snapshot, target: Selector, state: AgentRunnerState): Element[] {
  return target.ref ? remapReference(snapshot, target.ref, state) : find(snapshot, target);
}

function remapReference(snapshot: Snapshot, raw: string, state: AgentRunnerState): Element[] {
  const reference = raw.replace(/^@/, "");
  const previous = state.snapshot?.elements.find((element) => element.ref === reference);
  if (!previous) throw new Error(`unknown snapshot ref ${JSON.stringify(raw)}`);
  const byId = previous.id !== previous.path
    ? snapshot.elements.filter((element) => element.visible && !element.blocked && element.id === previous.id)
    : [];
  if (byId.length === 1) return byId;
  const semantic = snapshot.elements.filter((element) =>
    element.visible && !element.blocked && element.actionable
      && element.label === previous.label && element.role === previous.role && element.type === previous.type
  );
  if (semantic.length <= 1) return semantic;
  const ordered = semantic
    .map((element) => ({ element, distance: frameDistance(previous.frame, element.frame) }))
    .sort((left, right) => left.distance - right.distance);
  if (ordered[0]!.distance <= REF_REMAP_MAX_DISTANCE
    && ordered[1]!.distance - ordered[0]!.distance >= REF_REMAP_MIN_MARGIN) {
    return [ordered[0]!.element];
  }
  return semantic;
}

function actionableElement(element: Element, target: Selector): Element {
  if (!element.visible || !element.enabled || !element.actionable || element.blocked) {
    throw new Error(`${JSON.stringify(target)} is not actionable`);
  }
  return element;
}

function find(snapshot: Snapshot, target: Selector): Element[] {
  return snapshot.elements.filter((element) => {
    if (!element.visible || element.blocked) return false;
    if (target.ref) return element.ref === target.ref.replace(/^@/, "");
    if (target.text) {
      const needle = normalize(target.text);
      return normalize(`${element.label} ${element.value}`).includes(needle);
    }
    return (target.id === undefined || element.id === target.id)
      && (target.label === undefined || element.label === target.label)
      && (target.value === undefined || element.value === target.value)
      && (target.role === undefined || element.role === target.role)
      && (target.type === undefined || element.type === target.type);
  });
}

function nearestActionable(snapshot: Snapshot, element: Element): Element | undefined {
  let parentPath = element.parentPath;
  while (parentPath) {
    const parent = snapshot.elements.find((candidate) => candidate.path === parentPath);
    if (!parent) break;
    if (parent.visible && parent.enabled && parent.actionable && !parent.blocked) return parent;
    parentPath = parent.parentPath;
  }
  return snapshot.elements.find((candidate) =>
    candidate.visible && candidate.enabled && candidate.actionable && !candidate.blocked
      && candidate.path.startsWith(`${element.path}.`) && framesOverlap(candidate.frame, element.frame)
  );
}

function formatSnapshot(snapshot: Snapshot, options: SnapshotOptions): string {
  const lines = [`snapshot s${snapshot.generation} ${Math.round(snapshot.width)}x${Math.round(snapshot.height)}`];
  for (const element of snapshot.elements) {
    if (!options.all && !element.visible) continue;
    if (options.interactive && !element.ref) continue;
    if (!element.ref && !element.label && !element.value) continue;
    const fields = [
      element.ref ? `@${element.ref}` : undefined,
      (element.role || element.type || "element").toLowerCase(),
      element.label ? JSON.stringify(element.label) : undefined,
      element.value ? `value=${JSON.stringify(element.value)}` : undefined,
      element.id !== element.path ? `id=${JSON.stringify(element.id)}` : undefined,
      element.blocked ? "blocked=covered" : undefined,
    ].filter(Boolean);
    lines.push(fields.join(" "));
  }
  return lines.join("\n");
}

function snapshotOperation(raw: unknown): SnapshotOptions {
  const value = object(raw, "snapshot");
  return { interactive: value.interactive === true, all: value.all === true };
}

function coordinates(value: Record<string, unknown>): [number, number] | undefined {
  if (value.x === undefined && value.y === undefined) return undefined;
  return [finiteNumber(value.x, "tap.x"), finiteNumber(value.y, "tap.y")];
}

function point(raw: unknown, name: string): [number, number] {
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error(`${name} must contain [x, y]`);
  const value: [number, number] = [finiteNumber(raw[0], `${name}[0]`), finiteNumber(raw[1], `${name}[1]`)];
  validateCoordinates(value);
  return value;
}

function touchPair(raw: unknown, name: string): [number, number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 4) throw new Error(`${name} must contain [x1, y1, x2, y2]`);
  const value = raw.map((item, index) => finiteNumber(item, `${name}[${index}]`)) as [number, number, number, number];
  validateCoordinates(value);
  return value;
}

function validateCoordinates(values: number[]): void {
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("coordinates must be normalized between 0 and 1");
  }
}

function positiveDuration(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = finiteNumber(raw, "duration");
  if (value <= 0 || value > 60_000) throw new Error("duration must be between 1 and 60000 ms");
  return value;
}

function frame(raw: unknown, name: string): Frame {
  const value = object(raw, name);
  return {
    x: finiteNumber(value.x, `${name}.x`),
    y: finiteNumber(value.y, `${name}.y`),
    width: finiteNumber(value.width, `${name}.width`),
    height: finiteNumber(value.height, `${name}.height`),
  };
}

function object(raw: unknown, name: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${name} must be an object`);
  return raw as Record<string, unknown>;
}

function finiteNumber(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`${name} must be a finite number`);
  return raw;
}

function string(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function normalizedCenter(element: Element, snapshot: Snapshot): [number, number] {
  return [
    (element.frame.x + element.frame.width / 2) / Math.max(1, snapshot.width),
    (element.frame.y + element.frame.height / 2) / Math.max(1, snapshot.height),
  ];
}

function frameCenter(value: Frame): [number, number] {
  return [value.x + value.width / 2, value.y + value.height / 2];
}

function inside(point: [number, number], area: Frame): boolean {
  return point[0] >= area.x && point[0] <= area.x + area.width
    && point[1] >= area.y && point[1] <= area.y + area.height;
}

function visible(value: Frame, screen: Frame): boolean {
  return value.width > 0 && value.height > 0
    && value.x < screen.width && value.y < screen.height
    && value.x + value.width > 0 && value.y + value.height > 0;
}

function actionable(role: string, type: string, id: string, path: string, label: string): boolean {
  return ["button", "link", "back button", "text field", "search text field", "switch", "slider", "checkbox"]
    .includes(role.toLowerCase())
    || ["Button", "Link", "TextField", "SecureTextField", "CheckBox", "Slider", "Switch"].includes(type)
    || (id !== path && label.length > 0);
}

function implicitRowActionable(
  type: string,
  label: string,
  value: Frame,
  ancestorTypes: string[],
  screenWidth: number,
): boolean {
  return ["Other", "GenericElement", "Cell"].includes(type)
    && label.length > 0
    && value.height >= 44 && value.height <= 160
    && value.width >= 120 && value.width >= screenWidth * 0.4
    && ancestorTypes.some((ancestor) => ["ScrollView", "CollectionView", "Table", "List"].includes(ancestor));
}

function framesOverlap(left: Frame, right: Frame): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function frameDistance(left: Frame, right: Frame): number {
  const leftCenter = frameCenter(left);
  const rightCenter = frameCenter(right);
  return Math.hypot(leftCenter[0] - rightCenter[0], leftCenter[1] - rightCenter[1]);
}

function sameFrame(a: Frame, b: Frame): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5
    && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
