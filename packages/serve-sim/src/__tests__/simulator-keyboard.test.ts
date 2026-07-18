import { describe, expect, test } from "bun:test";
import {
  isServeSimTextInput,
  SemanticTextBatcher,
  shouldForwardSimulatorKeyboard,
  SimulatorKeyboardTranslator,
  type KeyboardLikeEvent,
} from "../client/utils/simulator-keyboard";

function key(
  code: string,
  value: string,
  modifiers: Partial<KeyboardLikeEvent> = {},
): KeyboardLikeEvent {
  return {
    code,
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...modifiers,
  };
}

function recorder() {
  const text: string[] = [];
  const hid: Array<["down" | "up", number]> = [];
  return {
    text,
    hid,
    translator: new SimulatorKeyboardTranslator({
      sendText: (value) => text.push(value),
      sendHid: (type, usage) => hid.push([type, usage]),
    }),
  };
}

describe("browser simulator keyboard translation", () => {
  test("batches adjacent semantic text and preserves ordering before HID", async () => {
    const operations: string[] = [];
    const batcher = new SemanticTextBatcher({
      delayMs: 1,
      sendText: async (value) => { operations.push(`text:${value}`); },
      sendHid: async (type, usage) => { operations.push(`${type}:${usage}`); },
    });
    batcher.text("azerty");
    batcher.text(".é");
    batcher.hid("down", 0x2a);
    batcher.hid("up", 0x2a);
    await batcher.flush();
    expect(operations).toEqual(["text:azerty.é", "down:42", "up:42"]);
  });

  test("uses committed text rather than physical keys for French AZERTY letters", () => {
    const { translator, text, hid } = recorder();
    expect(translator.keyDown(key("KeyQ", "a"))).toBe(false);
    expect(translator.beforeInput("insertText", "a")).toBe(true);
    expect(translator.keyUp(key("KeyQ", "a"))).toBe(false);
    expect(translator.keyDown(key("Digit2", "é"))).toBe(false);
    translator.beforeInput("insertText", "é");
    translator.beforeInput("insertText", "?;");
    expect(text).toEqual(["a", "é", "?;"]);
    expect(hid).toEqual([]);
  });

  test("sends a paste as one semantic text operation", () => {
    const { translator, text, hid } = recorder();
    translator.keyDown(key("MetaLeft", "Meta", { metaKey: true }));
    expect(translator.keyDown(key("KeyV", "v", { metaKey: true }))).toBe(false);
    expect(translator.paste("déjà vu !\nligne 2")).toBe(true);
    expect(translator.beforeInput("insertFromPaste", null)).toBe(true);
    translator.keyUp(key("KeyV", "v", { metaKey: true }));
    translator.keyUp(key("MetaLeft", "Meta"));
    expect(text).toEqual(["déjà vu !\nligne 2"]);
    expect(hid).toEqual([]);
  });

  test("sends only the final IME composition commit", () => {
    const { translator, text } = recorder();
    translator.compositionStart();
    expect(translator.beforeInput("insertCompositionText", "e", true)).toBe(false);
    expect(translator.beforeInput("insertCompositionText", "é", true)).toBe(false);
    expect(translator.compositionEnd("é")).toBe(true);
    expect(translator.beforeInput("insertText", "é")).toBe(true);
    translator.clearCompositionCommit();
    translator.beforeInput("insertText", "é");
    translator.beforeInput("insertText", "!");
    expect(text).toEqual(["é", "é", "!"]);
  });

  test("keeps Backspace and Enter on physical HID", () => {
    const { translator, text, hid } = recorder();
    translator.keyDown(key("Backspace", "Backspace"));
    translator.keyUp(key("Backspace", "Backspace"));
    translator.keyDown(key("Enter", "Enter"));
    translator.keyUp(key("Enter", "Enter"));
    expect(text).toEqual([]);
    expect(hid).toEqual([
      ["down", 0x2a], ["up", 0x2a],
      ["down", 0x28], ["up", 0x28],
    ]);
  });

  test("keeps shortcuts physical while Option and AltGr text stay semantic", () => {
    const { translator, text, hid } = recorder();
    translator.keyDown(key("MetaLeft", "Meta", { metaKey: true }));
    translator.keyDown(key("KeyC", "c", { metaKey: true }));
    translator.keyUp(key("KeyC", "c", { metaKey: true }));
    translator.keyUp(key("MetaLeft", "Meta"));

    translator.keyDown(key("AltLeft", "Alt", { altKey: true }));
    expect(translator.keyDown(key("Digit5", "[", { altKey: true }))).toBe(false);
    translator.beforeInput("insertText", "[");
    translator.keyUp(key("Digit5", "[", { altKey: true }));
    translator.keyUp(key("AltLeft", "Alt"));
    translator.keyDown(key("ControlLeft", "Control", { ctrlKey: true }));
    translator.keyDown(key("AltRight", "AltGraph", { ctrlKey: true, altKey: true }));
    expect(translator.keyDown(key("Digit0", "@", { ctrlKey: true, altKey: true }))).toBe(false);
    translator.beforeInput("insertText", "@");
    translator.keyUp(key("Digit0", "@", { ctrlKey: true, altKey: true }));
    translator.keyUp(key("AltRight", "AltGraph", { ctrlKey: true, altKey: true }));
    translator.keyUp(key("ControlLeft", "Control"));

    expect(hid).toEqual([
      ["down", 0xe3], ["down", 0x06], ["up", 0x06], ["up", 0xe3],
    ]);
    expect(text).toEqual(["[", "@"]);
  });

  test("does not leak Shift into semantic uppercase and punctuation input", () => {
    const { translator, text, hid } = recorder();
    translator.keyDown(key("ShiftLeft", "Shift"));
    expect(translator.keyDown(key("KeyQ", "A"))).toBe(false);
    translator.beforeInput("insertText", "A");
    translator.keyUp(key("KeyQ", "A"));
    translator.keyUp(key("ShiftLeft", "Shift"));

    expect(text).toEqual(["A"]);
    expect(hid).toEqual([]);
  });

  test("flushes buffered modifiers for non-text keys", () => {
    const { translator, hid } = recorder();
    translator.keyDown(key("ShiftLeft", "Shift"));
    translator.keyDown(key("Enter", "Enter"));
    translator.keyUp(key("Enter", "Enter"));
    translator.keyUp(key("ShiftLeft", "Shift"));

    expect(hid).toEqual([
      ["down", 0xe1], ["down", 0x28], ["up", 0x28], ["up", 0xe1],
    ]);
  });

  test("recognizes serve-sim controls and excludes only the hidden simulator sink", () => {
    const control = {
      closest: () => ({ hasAttribute: () => false }),
    } as unknown as EventTarget;
    const sink = {
      closest: () => ({ hasAttribute: (name: string) => name === "data-serve-sim-keyboard-sink" }),
    } as unknown as EventTarget;
    expect(isServeSimTextInput(control)).toBe(true);
    expect(isServeSimTextInput(sink)).toBe(false);
    expect(isServeSimTextInput(null)).toBe(false);
    expect(shouldForwardSimulatorKeyboard(true, control)).toBe(false);
    expect(shouldForwardSimulatorKeyboard(true, sink)).toBe(true);
    expect(shouldForwardSimulatorKeyboard(false, sink)).toBe(false);
  });
});
