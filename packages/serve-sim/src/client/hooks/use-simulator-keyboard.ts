import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  shouldForwardSimulatorKeyboard,
  SemanticTextBatcher,
  SimulatorKeyboardTranslator,
} from "../utils/simulator-keyboard";

type UseSimulatorKeyboardOptions = {
  containerRef: RefObject<HTMLElement | null>;
  sendText: (text: string) => Promise<void> | void;
  sendHid: (type: "down" | "up", usage: number) => void;
  onHome: () => void;
  onRotate: (direction: "left" | "right") => void;
  onToggleAppearance: () => void;
  onToggleSoftwareKeyboard: () => void;
};

export function useSimulatorKeyboard(options: UseSimulatorKeyboardOptions) {
  const sinkRef = useRef<HTMLTextAreaElement | null>(null);
  const simulatorFocusedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const batcher = new SemanticTextBatcher({
      sendText: (text) => optionsRef.current.sendText(text),
      sendHid: (type, usage) => optionsRef.current.sendHid(type, usage),
    });
    const translator = new SimulatorKeyboardTranslator({
      sendText: (text) => batcher.text(text),
      sendHid: (type, usage) => batcher.hid(type, usage),
    });
    let compositionCommitTimer: ReturnType<typeof setTimeout> | null = null;
    let suppressInputTimer: ReturnType<typeof setTimeout> | null = null;
    let suppressNextInput = false;
    const sink = sinkRef.current;
    if (!sink) return;
    if (document.activeElement === document.body) sink.focus({ preventScroll: true });

    const simulatorAcceptsKeyboard = (target: EventTarget | null) =>
      shouldForwardSimulatorKeyboard(simulatorFocusedRef.current, target ?? document.activeElement);

    const onPointerDown = (event: PointerEvent) => {
      const inside = !!optionsRef.current.containerRef.current?.contains(event.target as Node);
      simulatorFocusedRef.current = inside;
      if (inside) sink.focus({ preventScroll: true });
      else translator.releaseAll();
    };

    const handleServeSimShortcut = (event: KeyboardEvent, type: "down" | "up") => {
      if (event.code === "KeyH" && event.metaKey && event.shiftKey) {
        event.preventDefault();
        if (type === "down" && !event.repeat) optionsRef.current.onHome();
        return true;
      }
      if ((event.code === "ArrowLeft" || event.code === "ArrowRight")
          && event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey) {
        event.preventDefault();
        if (type === "down" && !event.repeat) {
          optionsRef.current.onRotate(event.code === "ArrowLeft" ? "left" : "right");
        }
        return true;
      }
      if (event.code === "KeyA" && event.metaKey && event.shiftKey) {
        event.preventDefault();
        if (type === "down" && !event.repeat) optionsRef.current.onToggleAppearance();
        return true;
      }
      if (event.code === "KeyK" && event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey) {
        event.preventDefault();
        if (type === "down" && !event.repeat) optionsRef.current.onToggleSoftwareKeyboard();
        return true;
      }
      return false;
    };

    const onKey = (event: KeyboardEvent, type: "down" | "up") => {
      if (!simulatorAcceptsKeyboard(event.target)) return;
      if (handleServeSimShortcut(event, type)) return;
      const handled = type === "down"
        ? translator.keyDown(event)
        : translator.keyUp(event);
      if (handled) event.preventDefault();
    };
    const onKeyDown = (event: KeyboardEvent) => onKey(event, "down");
    const onKeyUp = (event: KeyboardEvent) => onKey(event, "up");
    const onBeforeInput = (event: InputEvent) => {
      if (!simulatorAcceptsKeyboard(event.target)) return;
      if (translator.beforeInput(event.inputType, event.data, event.isComposing)) {
        suppressNextInput = true;
        if (suppressInputTimer) clearTimeout(suppressInputTimer);
        suppressInputTimer = setTimeout(() => {
          suppressNextInput = false;
          suppressInputTimer = null;
        }, 0);
        event.preventDefault();
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!simulatorAcceptsKeyboard(event.target)) return;
      if (translator.paste(event.clipboardData?.getData("text/plain") ?? "")) {
        event.preventDefault();
      }
    };
    const onInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      if (!inputEvent.isComposing && sink.value && !suppressNextInput) batcher.text(sink.value);
      suppressNextInput = false;
      if (suppressInputTimer) clearTimeout(suppressInputTimer);
      suppressInputTimer = null;
      sink.value = "";
    };
    const onCompositionStart = () => translator.compositionStart();
    const onCompositionEnd = (event: CompositionEvent) => {
      translator.compositionEnd(event.data);
      sink.value = "";
      if (compositionCommitTimer) clearTimeout(compositionCommitTimer);
      compositionCommitTimer = setTimeout(() => translator.clearCompositionCommit(), 0);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    sink.addEventListener("beforeinput", onBeforeInput);
    sink.addEventListener("input", onInput);
    sink.addEventListener("paste", onPaste);
    sink.addEventListener("compositionstart", onCompositionStart);
    sink.addEventListener("compositionend", onCompositionEnd);
    return () => {
      translator.releaseAll();
      void batcher.flush();
      if (compositionCommitTimer) clearTimeout(compositionCommitTimer);
      if (suppressInputTimer) clearTimeout(suppressInputTimer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      sink.removeEventListener("beforeinput", onBeforeInput);
      sink.removeEventListener("input", onInput);
      sink.removeEventListener("paste", onPaste);
      sink.removeEventListener("compositionstart", onCompositionStart);
      sink.removeEventListener("compositionend", onCompositionEnd);
    };
  }, []);

  const blur = useCallback(() => {
    simulatorFocusedRef.current = false;
    sinkRef.current?.blur();
  }, []);
  return { sinkRef, blur };
}
