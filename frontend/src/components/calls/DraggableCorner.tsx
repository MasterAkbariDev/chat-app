"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { nearestCorner, type Corner } from "./call-utils";

/** A box pinned to one corner of its container (or the viewport, `fixed`)
 * that can be dragged anywhere and snaps to the nearest corner on release —
 * the self-view in a 1:1 call and the minimized call card. A drag never
 * counts as a click, so it doesn't also swap views / expand the call.
 * Arrow keys move it between corners for keyboard users. */
export function DraggableCorner({
  children,
  width,
  height,
  offsets,
  fixed,
  defaultCorner = "top-end",
  label,
  className,
}: {
  children: React.ReactNode;
  width: number | string;
  height: number | string;
  /** CSS lengths from each edge (may use env()/calc()). */
  offsets: { top: string; bottom: string; side: string };
  fixed?: boolean;
  defaultCorner?: Corner;
  /** Accessible name of the movable region. */
  label: string;
  className?: string;
}) {
  const [corner, setCorner] = useState<Corner>(defaultCorner);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const start = useRef<{ x: number; y: number; id: number; moved: boolean } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
  }
  function onPointerMove(e: React.PointerEvent) {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.moved && Math.hypot(dx, dy) < 6) return;
    if (!s.moved) {
      s.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    setDrag({ dx, dy });
  }
  function onPointerUp(e: React.PointerEvent) {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId || !s.moved) return;
    suppressClick.current = true;
    const el = boxRef.current;
    const box = el?.getBoundingClientRect();
    const parent = fixed
      ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      : el?.offsetParent?.getBoundingClientRect();
    setDrag(null);
    if (!el || !box || !parent) return;
    const rtl = getComputedStyle(el).direction === "rtl";
    setCorner(nearestCorner(box.left + box.width / 2 - parent.left, box.top + box.height / 2 - parent.top, parent.width, parent.height, rtl));
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (!e.altKey) return;
    const [v, h] = corner.split("-") as ["top" | "bottom", "start" | "end"];
    const rtl = boxRef.current ? getComputedStyle(boxRef.current).direction === "rtl" : false;
    let next: Corner | null = null;
    if (e.key === "ArrowUp") next = `top-${h}`;
    else if (e.key === "ArrowDown") next = `bottom-${h}`;
    else if (e.key === "ArrowLeft") next = `${v}-${rtl ? "end" : "start"}`;
    else if (e.key === "ArrowRight") next = `${v}-${rtl ? "start" : "end"}`;
    if (next) {
      e.preventDefault();
      setCorner(next);
    }
  }

  const [v, h] = corner.split("-") as ["top" | "bottom", "start" | "end"];
  return (
    <div
      ref={boxRef}
      role="group"
      aria-label={`${label} (Alt + arrow keys to move)`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
      onKeyDown={onKeyDown}
      onClickCapture={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      data-corner={corner}
      className={cn(
        fixed ? "fixed" : "absolute",
        "z-10 touch-none select-none",
        drag ? "cursor-grabbing" : "cursor-grab transition-[top,bottom,left,right] duration-[var(--dur-slow)] ease-[var(--ease-out)]",
        className,
      )}
      style={{
        width,
        height,
        top: v === "top" ? offsets.top : undefined,
        bottom: v === "bottom" ? offsets.bottom : undefined,
        insetInlineStart: h === "start" ? offsets.side : undefined,
        insetInlineEnd: h === "end" ? offsets.side : undefined,
        transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
      }}
    >
      {children}
    </div>
  );
}
