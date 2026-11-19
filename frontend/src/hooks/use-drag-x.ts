"use client";

import { useCallback, useRef, useState } from "react";

interface UseDragXOptions {
  /** Called when a horizontal drag is released (or leaves), with the final delta. Not called for
   *  a scroll or a cancelled gesture. */
  onEnd?: (deltaX: number) => void;
}

/** Movement before a press counts as a swipe. Small wobbles while scrolling stay below it. */
const AXIS_SLOP = 12;

/**
 * Low-level horizontal pointer-drag tracker shared by swipe-to-reveal list
 * rows and swipe-to-reply message bubbles. It only reports a live delta and
 * a drag-end delta — callers decide what threshold/clamp/open-state means.
 *
 * A press first has to move past AXIS_SLOP, and the first real move decides the axis:
 * mostly vertical means a scroll, and the gesture is ignored from then on (no offset, no
 * callback). Only a horizontal lock tracks a drag, measured from where it locked, so a
 * scroll that drifts sideways a few pixels never shifts the element.
 *
 * Correctness details that matter for a fast real flick, not just for
 * automated testing:
 *  - Drag state lives in refs, read synchronously by each handler. A quick
 *    flick can deliver pointerdown/pointermove/pointerup within the same
 *    tick, before React commits the prior setState, so a handler reading
 *    only a state closure can act on a stale value.
 *  - Once locked horizontal the pointer is captured on the dragged element
 *    (`setPointerCapture`) so a fast move — which shifts the element out from
 *    under the cursor via `translateX` — can't fire a spurious `pointerleave`
 *    mid-drag and end the gesture early with whatever partial delta it had.
 *  - A `pointercancel` (the browser taking the touch for scrolling) resets
 *    without calling `onEnd`, so it can never count as a completed swipe.
 */
export function useDragX({ onEnd }: UseDragXOptions = {}) {
  const [dragging, setDragging] = useState(false);
  const [delta, setDelta] = useState(0);
  // idle: no press. pending: pressed, axis not yet known. x: horizontal drag. y: a scroll.
  const modeRef = useRef<"idle" | "pending" | "x" | "y">("idle");
  const deltaRef = useRef(0);
  const startX = useRef(0);
  const startY = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startX.current = e.clientX;
    startY.current = e.clientY;
    deltaRef.current = 0;
    modeRef.current = "pending";
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const mode = modeRef.current;
    if (mode !== "pending" && mode !== "x") return;
    const dx = e.clientX - startX.current;
    const dy = e.clientY - startY.current;
    if (mode === "pending") {
      if (Math.hypot(dx, dy) < AXIS_SLOP) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        modeRef.current = "y";
        return;
      }
      modeRef.current = "x";
      setDragging(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // No active pointer session to capture — the drag still works via the refs above.
      }
    }
    // Measured from the lock point, so the element starts from rest rather than jumping.
    const d = dx - Math.sign(dx) * AXIS_SLOP;
    deltaRef.current = d;
    setDelta(d);
  }, []);

  const release = useCallback((e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const finish = useCallback(
    (e: React.PointerEvent) => {
      const wasDrag = modeRef.current === "x";
      const final = deltaRef.current;
      modeRef.current = "idle";
      deltaRef.current = 0;
      setDragging(false);
      setDelta(0);
      release(e);
      if (wasDrag) onEnd?.(final);
    },
    [onEnd, release],
  );

  const cancel = useCallback(
    (e: React.PointerEvent) => {
      modeRef.current = "idle";
      deltaRef.current = 0;
      setDragging(false);
      setDelta(0);
      release(e);
    },
    [release],
  );

  return {
    dragging,
    delta,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerLeave: finish,
      onPointerCancel: cancel,
    },
  };
}
