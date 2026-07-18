import { hidUsageForCode } from "./hid";

export type KeyboardLikeEvent = {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
};

type KeyboardTranslatorOptions = {
  sendText: (text: string) => void;
  sendHid: (type: "down" | "up", usage: number) => void;
};

type SemanticTextBatcherOptions = {
  sendText: (text: string) => Promise<void> | void;
  sendHid: (type: "down" | "up", usage: number) => Promise<void> | void;
  delayMs?: number;
};

const TEXT_INPUT_TYPES = new Set([
  "insertText",
  "insertReplacementText",
  "insertTranspose",
]);

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

export function isServeSimTextInput(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const editable = (target as Element).closest("input, textarea, select, [contenteditable]");
  return !!editable && !editable.hasAttribute("data-serve-sim-keyboard-sink");
}

export function shouldForwardSimulatorKeyboard(
  simulatorFocused: boolean,
  target: EventTarget | null,
): boolean {
  return simulatorFocused && !isServeSimTextInput(target);
}

export function isPrintableKeyboardEvent(event: KeyboardLikeEvent): boolean {
  return event.isComposing === true
    || event.key === "Dead"
    || event.key === "Process"
    || event.key.length === 1;
}

export function isPhysicalShortcut(event: KeyboardLikeEvent): boolean {
  // Alt/Option and AltGr produce printable characters on many layouts. Only
  // Command and a non-Alt Control chord are unambiguously shortcuts here.
  return event.metaKey || (event.ctrlKey && !event.altKey);
}

export class SemanticTextBatcher {
  private pendingText = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private operations = Promise.resolve();

  constructor(private readonly options: SemanticTextBatcherOptions) {}

  text(value: string): void {
    this.pendingText += value;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), this.options.delayMs ?? 16);
  }

  hid(type: "down" | "up", usage: number): void {
    this.flush();
    this.enqueue(() => this.options.sendHid(type, usage));
  }

  flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const text = this.pendingText;
    this.pendingText = "";
    if (text) this.enqueue(() => this.options.sendText(text));
    return this.operations;
  }

  private enqueue(operation: () => Promise<void> | void): void {
    this.operations = this.operations.catch(() => {}).then(operation);
  }
}

function isPasteShortcut(event: KeyboardLikeEvent): boolean {
  return event.code === "KeyV" && isPhysicalShortcut(event);
}

export class SimulatorKeyboardTranslator {
  private readonly heldUsages = new Set<number>();
  private readonly pendingModifierUsages = new Set<number>();
  private composing = false;
  private ignoreCommittedText: string | null = null;

  constructor(private readonly options: KeyboardTranslatorOptions) {}

  keyDown(event: KeyboardLikeEvent): boolean {
    const usage = hidUsageForCode(event.code);
    if (usage == null) return false;
    if (MODIFIER_CODES.has(event.code)) {
      this.pendingModifierUsages.add(usage);
      return false;
    }
    // Let the browser produce a paste event so clipboard contents cross the
    // semantic text path once. Sending physical V as well would duplicate it.
    if (isPasteShortcut(event)) return false;
    if (event.repeat && isPhysicalShortcut(event)) return true;
    if (isPrintableKeyboardEvent(event) && !isPhysicalShortcut(event)) return false;
    this.flushPendingModifiers();
    if (!this.heldUsages.has(usage)) {
      this.heldUsages.add(usage);
      this.options.sendHid("down", usage);
    }
    return true;
  }

  keyUp(event: KeyboardLikeEvent): boolean {
    const usage = hidUsageForCode(event.code);
    if (usage == null) return false;
    if (this.pendingModifierUsages.delete(usage)) return false;
    if (!this.heldUsages.delete(usage)) return false;
    this.options.sendHid("up", usage);
    return true;
  }

  beforeInput(inputType: string, data: string | null, isComposing = false): boolean {
    if (isComposing || this.composing || inputType.includes("Composition")) return false;
    if (inputType === "insertFromPaste" || inputType === "insertFromDrop") return true;
    if (!TEXT_INPUT_TYPES.has(inputType) || !data) return false;
    if (this.ignoreCommittedText === data) {
      this.ignoreCommittedText = null;
      return true;
    }
    this.ignoreCommittedText = null;
    this.options.sendText(data);
    return true;
  }

  paste(text: string): boolean {
    if (!text) return false;
    this.options.sendText(text);
    return true;
  }

  compositionStart(): void {
    this.composing = true;
    this.ignoreCommittedText = null;
  }

  compositionEnd(text: string): boolean {
    this.composing = false;
    if (!text) return false;
    this.options.sendText(text);
    // Chromium can emit a final insertText after compositionend. Suppress only
    // that identical commit; the next different beforeinput remains untouched.
    this.ignoreCommittedText = text;
    return true;
  }

  clearCompositionCommit(): void {
    this.ignoreCommittedText = null;
  }

  releaseAll(): void {
    for (const usage of this.heldUsages) this.options.sendHid("up", usage);
    this.heldUsages.clear();
    this.pendingModifierUsages.clear();
  }

  private flushPendingModifiers(): void {
    for (const usage of this.pendingModifierUsages) {
      this.heldUsages.add(usage);
      this.options.sendHid("down", usage);
    }
    this.pendingModifierUsages.clear();
  }
}
