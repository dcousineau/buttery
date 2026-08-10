import { useCallback, useEffect, useState } from "react";

/**
 * Native HTML5 drag-and-drop, made to keep its hands off text controls.
 *
 * A `draggable` ancestor swallows the press-and-drag gesture of every control
 * inside it: in Chrome, dragging across an `<input>` or `<textarea>` that sits in
 * a draggable row starts the row drag instead of selecting the text, so the one
 * gesture everybody knows for "highlight this" stops working. Cancelling in
 * `dragstart` is too late — the selection is already lost — so both hooks here
 * work the only way that actually restores native behaviour: they decide whether
 * the element is `draggable` *at all* on pointer-down, before the browser looks.
 *
 * Use {@link useDragHandle} when the surface has a grip (the row is dragged only
 * by its handle) and {@link useTextSafeDrag} when the whole surface is the drag
 * source and text controls must be carved out of it.
 */

/**
 * Controls whose own press-and-drag gesture must win over a drag: text entry
 * (selection), `select`/`option` (open list), and range inputs (scrubbing).
 * `[data-no-drag]` is the escape hatch for anything else a surface wants to
 * exempt.
 */
const TEXT_CONTROL_SELECTOR = "input, textarea, select, option, [contenteditable=''], [contenteditable='true'], [data-no-drag]";

/** Whether `target` is inside a control that owns its own press-and-drag gesture. */
export function isTextControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(TEXT_CONTROL_SELECTOR);
  // A file input is a button in a trench coat — it has no selection to protect,
  // and surfaces that hold one (drop zones) still want to be draggable.
  if (control instanceof HTMLInputElement && control.type === "file") return false;
  return control !== null;
}

/**
 * Arms a drag only while the pointer is down on the grip.
 *
 * Spread `handleProps` on the handle and set `draggable={armed}` on the element
 * that moves. Disarming is belt and braces: `dragend` covers the drag that
 * happened, and a window-level `pointerup` covers the press that never became
 * one (including one released outside the handle), so the surface is never left
 * armed with the pointer up.
 */
export function useDragHandle() {
  const [armed, setArmed] = useState(false);
  const disarm = useCallback(() => setArmed(false), []);

  useEffect(() => {
    if (!armed) return;
    window.addEventListener("pointerup", disarm);
    window.addEventListener("pointercancel", disarm);
    return () => {
      window.removeEventListener("pointerup", disarm);
      window.removeEventListener("pointercancel", disarm);
    };
  }, [armed, disarm]);

  return {
    /** Pass to the moving element's `draggable`. */
    armed,
    /** Spread on the grip. */
    handleProps: { onPointerDown: () => setArmed(true) },
    /** Call from the moving element's `onDragEnd`. */
    disarm,
  };
}

/**
 * A whole-surface drag source that steps aside for text controls inside it.
 *
 * Spread the returned props on the draggable element; `enabled` is the caller's
 * own reason to allow dragging at all (an unconfirmed card, say), and text
 * controls are subtracted from it.
 */
export function useTextSafeDrag(enabled = true) {
  const [suppressed, setSuppressed] = useState(false);
  return {
    draggable: enabled && !suppressed,
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      setSuppressed(isTextControlTarget(event.target));
    },
  };
}
