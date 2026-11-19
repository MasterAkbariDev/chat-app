"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { useBackToClose } from "@/hooks/use-back-to-close";
import { cn } from "@/lib/cn";

export type MenuItem =
  | {
      key: string;
      label: string;
      icon?: LucideIcon;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
    }
  | { key: string; separator: true };

export type MenuAnchor = { rect: DOMRect } | { point: { x: number; y: number } };

export interface MenuProps {
  anchor: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
  /** Horizontal alignment relative to a rect anchor. */
  align?: "start" | "end";
  /** Optional content above the items (e.g. a quick-reaction strip). */
  header?: React.ReactNode;
  "aria-label"?: string;
}

const GAP = 6;
const EDGE = 8;

/** Popover action menu, portalled and fixed-positioned so it's never
 * clipped by a scrolling list. Opens from a trigger's rect or a pointer
 * position (right-click / long-press), flips/clamps to stay on screen,
 * and supports the full menu keyboard model (arrows, Home/End, Enter,
 * Esc returns focus to the trigger, Tab closes). */
export function Menu({ anchor, items, onClose, align = "end", header, "aria-label": ariaLabel }: MenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  // Back (phone button/gesture, browser) closes the menu, not the page.
  useBackToClose(() => onCloseRef.current());
  const actionable = items.filter((i): i is Extract<MenuItem, { onSelect: () => void }> => !("separator" in i));

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const { width, height } = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top: number;
    let left: number;
    if ("rect" in anchor) {
      const r = anchor.rect;
      top = r.bottom + GAP;
      if (top + height > vh - EDGE) top = r.top - GAP - height;
      left = align === "end" ? r.right - width : r.left;
    } else {
      top = anchor.point.y;
      left = anchor.point.x;
      if (top + height > vh - EDGE) top = anchor.point.y - height;
      if (left + width > vw - EDGE) left = anchor.point.x - width;
    }
    top = Math.max(EDGE, Math.min(top, vh - height - EDGE));
    left = Math.max(EDGE, Math.min(left, vw - width - EDGE));
    setPos({ top, left });
  }, [anchor, align]);

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;

    function onPointerDown(e: PointerEvent) {
      if (!panelRef.current || panelRef.current.contains(e.target as Node)) return;
      // A press on this menu's own (expanded) trigger is left to the
      // trigger's click, which toggles it shut via `openFrom` — closing here
      // too made that click immediately re-open it, so the ⋯ button could
      // never close its own menu.
      if ((e.target as Element | null)?.closest?.('[aria-haspopup][aria-expanded="true"]')) return;
      onCloseRef.current();
    }
    function onDismiss() {
      onCloseRef.current();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    // Not on resize: the on-screen keyboard opening or closing resizes the window, and that
    // used to close a menu the moment it opened.
    window.addEventListener("blur", onDismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onDismiss);
      if (trigger && document.contains(trigger)) trigger.focus({ preventScroll: true });
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const idx = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      nodes[(idx + 1) % nodes.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nodes[(idx - 1 + nodes.length) % nodes.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      nodes[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      nodes[nodes.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      onClose();
    }
  }

  // Move focus in only once the panel is positioned: until then it carries
  // `invisible`, and a `visibility: hidden` element can't take focus — so
  // focusing on mount silently left focus on the trigger and arrow keys
  // did nothing.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!pos || focusedRef.current) return;
    // On a touch screen with the keyboard up, leave the focus in the field: moving it into the menu
    // would close the keyboard.
    const active = document.activeElement as HTMLElement | null;
    const editing = !!active && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA");
    if (editing && window.matchMedia?.("(pointer: coarse)").matches) return;
    focusedRef.current = true;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
  }, [pos]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        "fixed z-[90] min-w-[200px] max-w-[280px] overflow-hidden rounded-[var(--radius-md)] border border-line bg-raised p-1.5 shadow-lg",
        pos ? "pop-in" : "invisible",
      )}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, transformOrigin: "top" }}
    >
      {header}
      {items.map((item) =>
        "separator" in item ? (
          <div key={item.key} role="separator" className="-mx-1.5 my-1.5 h-px bg-line" />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={cn(
              // Inset, rounded highlight that fades in (not a flat edge-to-edge bar).
              "flex w-full items-center gap-3 rounded-[var(--radius-sm)] px-2.5 py-2.5 text-start text-[14.5px] font-medium outline-none transition-colors duration-[var(--dur-fast)] disabled:opacity-40",
              item.danger
                ? "text-danger hover:bg-danger/10 focus-visible:bg-danger/10"
                : "text-fg hover:bg-sunken focus-visible:bg-sunken [&:hover>svg]:text-fg [&:focus-visible>svg]:text-fg",
            )}
          >
            {item.icon ? <item.icon className={cn("size-[18px] shrink-0", item.danger ? "" : "text-fg-2")} strokeWidth={1.8} aria-hidden /> : null}
            <span className="truncate">{item.label}</span>
          </button>
        ),
      )}
      {actionable.length === 0 && !header ? <div className="px-3.5 py-2 text-[13px] text-muted">No actions</div> : null}
    </div>,
    document.body,
  );
}

/** Open/close state + anchor for a Menu, from a button or a pointer point. */
export function useMenuState() {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  // Toggles: a second click on the trigger closes the menu (see Menu's
  // pointerdown handler, which deliberately leaves that click to us).
  const openFrom = useCallback((el: HTMLElement) => setAnchor((prev) => (prev ? null : { rect: el.getBoundingClientRect() })), []);
  const openAt = useCallback((x: number, y: number) => setAnchor({ point: { x, y } }), []);
  const close = useCallback(() => setAnchor(null), []);
  return { anchor, open: anchor !== null, openFrom, openAt, close };
}

/** Long-press (touch) detection that doesn't block scrolling or normal
 * taps. Fires `onLongPress` with the touch point after `ms`; cancels if the
 * finger moves more than a few pixels. */
export function useLongPress(onLongPress: (x: number, y: number) => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  return {
    /** True if the most recent press turned into a long-press — check it in
     * onClick to swallow the tap that follows. */
    firedRef: fired,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        fired.current = false;
        if (e.pointerType !== "touch") return;
        start.current = { x: e.clientX, y: e.clientY };
        const { clientX, clientY } = e;
        timer.current = setTimeout(() => {
          fired.current = true;
          navigator.vibrate?.(8);
          onLongPress(clientX, clientY);
          clear();
        }, ms);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (!start.current) return;
        if (Math.abs(e.clientX - start.current.x) > 8 || Math.abs(e.clientY - start.current.y) > 8) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
    },
  };
}
