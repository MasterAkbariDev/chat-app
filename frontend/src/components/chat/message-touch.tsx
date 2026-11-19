"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, TextSelect, X } from "lucide-react";
import type { MenuItem } from "@/components/ui/Menu";
import { useBackToClose } from "@/hooks/use-back-to-close";
import { cn } from "@/lib/cn";
import { suppressLinkProgress } from "@/lib/nav-progress";

const LONG_PRESS_MS = 400;
const MOVE_TOLERANCE = 10;

/** Touch long-press for a message (or something inside one). Fires after
 * ~400 ms if the finger stayed within a few px, with a short haptic tick.
 * Cancelled by movement, by the browser taking the gesture over for
 * scrolling (pointercancel), and by any scroll while the finger is down —
 * so scrolling the (virtualized) list never opens a menu. `firedRef` stays
 * true until the next press, so a click that follows a long-press can be
 * swallowed. Mouse/pen are ignored (they have right-click). */
export function useTouchLongPress(onLongPress: (x: number, y: number) => void, enabled = true) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cb = useRef(onLongPress);
  useLayoutEffect(() => {
    cb.current = onLongPress;
  });

  // Stable identity: it's also the scroll listener it removes.
  const [clear] = useState(() => {
    const fn = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      start.current = null;
      window.removeEventListener("scroll", fn, true);
    };
    return fn;
  });
  useEffect(() => clear, [clear]);

  return {
    firedRef: fired,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        fired.current = false;
        if (!enabled || e.pointerType !== "touch" || e.isPrimary === false) return;
        clear();
        start.current = { x: e.clientX, y: e.clientY };
        const { clientX, clientY } = e;
        window.addEventListener("scroll", clear, true);
        timer.current = setTimeout(() => {
          fired.current = true;
          clear();
          swallowReleaseClick();
          try {
            navigator.vibrate?.(10);
          } catch {}
          cb.current(clientX, clientY);
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (!start.current) return;
        if (Math.abs(e.clientX - start.current.x) > MOVE_TOLERANCE || Math.abs(e.clientY - start.current.y) > MOVE_TOLERANCE) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
    },
  };
}

/** After a long-press fires, the finger's release can still arrive as a
 * click on whatever is under it — a link (the sender's name, a URL in the
 * text) would navigate and start the top progress bar. Swallow that one
 * click (window capture runs before everything else) and keep link clicks
 * from starting the bar meanwhile. The next press starts fresh. */
function swallowReleaseClick() {
  suppressLinkProgress();
  let done = false;
  let t: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    if (done) return;
    done = true;
    if (t) clearTimeout(t);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointerdown", onDown, true);
  };
  const onClick = (e: MouseEvent) => {
    // Only links — the action sheet handles its own release click, and a
    // press on anything else does nothing harmful.
    if ((e.target as Element | null)?.closest?.("a[href]")) {
      e.preventDefault();
      e.stopPropagation();
    }
    finish();
  };
  // The release click follows pointerup immediately; give it a beat.
  const onUp = () => {
    if (t) clearTimeout(t);
    t = setTimeout(finish, 350);
  };
  const onDown = () => finish();
  window.addEventListener("click", onClick, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointerdown", onDown, true);
  t = setTimeout(finish, 5000);
}

/** Phones and other touch-first screens get the bottom sheet instead of the
 * pointer-anchored popover menu. */
export function prefersActionSheet() {
  if (typeof window === "undefined") return false;
  return window.innerWidth < 768 || !!window.matchMedia?.("(pointer: coarse)").matches;
}

/** The message action menu as a bottom sheet (phones): reaction strip on
 * top, big rows, dismissed by tapping outside, swiping down, Esc, or the
 * system back button/gesture. */
export function MessageActionSheet({
  items,
  header,
  onClose,
  label = "Message actions",
}: {
  items: MenuItem[];
  header?: React.ReactNode;
  onClose: () => void;
  label?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<number | null>(null);
  const closedRef = useRef(false);
  /** False until the finger that long-pressed is lifted (plus a beat): the
   *  click a browser may send for that release must not hit a row. A press
   *  starting on the sheet, or a key, arms it right away. */
  const armedRef = useRef(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const release = () => {
      t = setTimeout(() => {
        armedRef.current = true;
      }, 80);
    };
    const key = () => {
      armedRef.current = true;
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("keydown", key, true);
    return () => {
      if (t) clearTimeout(t);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("keydown", key, true);
    };
  }, []);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // The system back button/gesture closes the sheet (not the page).
  useBackToClose(() => close());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  function close() {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  }

  const actionable = items.filter((i): i is Extract<MenuItem, { onSelect: () => void }> => !("separator" in i));

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex flex-col justify-end"
      data-message-sheet=""
      onPointerDownCapture={() => {
        armedRef.current = true;
      }}
      // The finger that long-pressed the message is still down when the sheet
      // appears; its release can arrive as a click on whatever row is now
      // under it — swallow clicks until the sheet is armed.
      onClickCapture={(e) => {
        if (armedRef.current) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div
        aria-hidden
        className="fade-in absolute inset-0 bg-black/35"
        onClick={close}
      />
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        className="sheet-up relative flex max-h-[85dvh] flex-col overflow-hidden rounded-t-[var(--radius-lg)] border-t border-line bg-raised shadow-lg"
        style={{
          transform: drag ? `translateY(${drag}px)` : undefined,
          transition: dragStart.current !== null ? "none" : "transform 200ms var(--ease-out)",
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== "touch") return;
          // Only from the top (handle + reaction strip), so the list can scroll.
          const top = panelRef.current?.getBoundingClientRect().top ?? 0;
          if (e.clientY - top > 96) return;
          dragStart.current = e.clientY;
        }}
        onPointerMove={(e) => {
          if (dragStart.current === null) return;
          setDrag(Math.max(0, e.clientY - dragStart.current));
        }}
        onPointerUp={() => {
          if (dragStart.current === null) return;
          dragStart.current = null;
          if (drag > 80) close();
          else setDrag(0);
        }}
        onPointerCancel={() => {
          dragStart.current = null;
          setDrag(0);
        }}
      >
        {/* touch-none: the drag-to-dismiss area, so the browser doesn't claim the gesture. */}
        <div className="shrink-0 touch-none">
          <div aria-hidden className="mx-auto mb-1 mt-2.5 h-1 w-10 rounded-full bg-line-strong" />
          {header ? <div className="px-2 [&>div]:justify-between [&>div]:border-b-0 [&>div]:pb-2">{header}</div> : <div className="h-2" />}
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain border-t border-line px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-1">
          {items.map((item) =>
            "separator" in item ? (
              <div key={item.key} role="separator" className="mx-3 my-1 h-px bg-line" />
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  close();
                  item.onSelect();
                }}
                className={cn(
                  "pressable flex min-h-[52px] w-full items-center gap-3.5 rounded-[var(--radius-sm)] px-3.5 text-start text-[16px] font-medium",
                  item.danger ? "text-danger hover:bg-danger-soft" : "text-fg hover:bg-sunken",
                  item.disabled && "opacity-50",
                )}
              >
                {item.icon ? <item.icon className="size-[21px] shrink-0" strokeWidth={1.8} aria-hidden /> : null}
                {item.label}
              </button>
            ),
          )}
          {actionable.length === 0 ? <p className="px-3 py-4 text-[14px] text-muted">No actions for this message.</p> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Copy to the clipboard, with a fallback for browsers/contexts without the
 *  async Clipboard API (plain-http LAN, older WebViews). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** The current selection's text inside `el`, with inline animated emoji
 *  (images) turned back into their emoji characters — a plain
 *  `Selection.toString()` drops them. "" when nothing in `el` is selected. */
export function selectedTextWithin(el: HTMLElement | null): string {
  const sel = typeof window === "undefined" ? null : window.getSelection();
  if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer) && !range.intersectsNode(el)) return "";
  const clipped = document.createRange();
  clipped.selectNodeContents(el);
  if (el.contains(range.startContainer)) clipped.setStart(range.startContainer, range.startOffset);
  if (el.contains(range.endContainer)) clipped.setEnd(range.endContainer, range.endOffset);
  const frag = clipped.cloneContents();
  frag.querySelectorAll("img[alt]").forEach((img) => img.replaceWith(document.createTextNode(img.getAttribute("alt") ?? "")));
  return frag.textContent ?? "";
}

/** "Select text" mode for one message (Telegram's text-selection action
 *  bar): ✕ (cancel), Select all and Copy — a top app bar on phones, a small
 *  bar right above the message elsewhere — so it never sits on the text
 *  being selected. Cancelled by ✕, Esc, the system
 *  back button, or a tap outside the message. */
export function SelectTextBar({ target, text, onDone }: { target: React.RefObject<HTMLElement | null>; text: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  /** Phones: a top app bar. Pointer screens: a compact bar pinned just
   *  above (or, without room, below) the message — a full-width top bar
   *  would sit over the sidebar, far from what's being selected. */
  const [floating] = useState(() => !prefersActionSheet());
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const onDoneRef = useRef(onDone);
  useLayoutEffect(() => {
    onDoneRef.current = onDone;
  });
  useBackToClose(() => onDoneRef.current());

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onDoneRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
    };
  }, [target]);

  useLayoutEffect(() => {
    if (!floating) return;
    let raf = 0;
    const place = () => {
      raf = 0;
      const el = target.current;
      const bar = barRef.current;
      if (!el || !bar) return;
      const r = el.getBoundingClientRect();
      const { width, height } = bar.getBoundingClientRect();
      const above = r.top - height - 10;
      const top = above >= 64 ? above : Math.min(r.bottom + 10, window.innerHeight - height - 8);
      // Line the bar up with the bubble's outer edge (right for own messages).
      const mineSide = r.left + r.width / 2 > window.innerWidth / 2;
      const left = Math.max(8, Math.min(mineSide ? r.right - width : r.left, window.innerWidth - width - 8));
      setPos({ top, left });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(place);
    };
    place();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [floating, target]);

  function selectAll() {
    const el = target.current;
    const sel = window.getSelection();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function copy() {
    const picked = selectedTextWithin(target.current);
    // Nothing or everything selected → the message's own text (exact, emoji included).
    const all = (target.current?.textContent ?? "").trim();
    const whole = !picked.trim() || picked.trim() === all || picked.length >= text.length;
    const ok = await copyText(whole ? text : picked);
    setCopied(ok);
    if (ok) setTimeout(() => onDoneRef.current(), 600);
  }

  // Keep the selection: a press on a bar button would otherwise clear it.
  const keep = {
    onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Text selection"
      className={cn(
        "fixed z-[85] bg-raised",
        floating
          ? "pop-in rounded-full border border-line p-1 shadow-lg"
          : "fade-in safe-top inset-x-0 top-0 border-b border-line shadow-md",
      )}
      style={floating ? (pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }) : undefined}
    >
      <div className={cn("flex items-center gap-1", floating ? "h-11" : "mx-auto h-14 max-w-[860px] px-2")}>
        <button
          type="button"
          {...keep}
          onClick={() => onDoneRef.current()}
          aria-label="Cancel selection"
          title="Cancel (Esc)"
          className="pressable flex size-11 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-sunken hover:text-fg"
        >
          <X className="size-[22px]" strokeWidth={2} />
        </button>
        {floating ? null : <span className="min-w-0 flex-1 truncate ps-1 text-[16px] font-semibold text-fg">Select text</span>}
        <button
          type="button"
          {...keep}
          onClick={selectAll}
          className="pressable flex h-11 shrink-0 items-center gap-2 rounded-full px-3 text-[15px] font-semibold text-fg hover:bg-sunken"
        >
          <TextSelect className="size-[18px]" strokeWidth={1.9} aria-hidden />
          <span className="max-[359px]:sr-only">Select all</span>
        </button>
        <button
          type="button"
          {...keep}
          onClick={() => void copy()}
          className="pressable flex h-11 shrink-0 items-center gap-2 rounded-full bg-accent px-4 text-[15px] font-semibold text-accent-fg hover:bg-accent-hover"
        >
          {copied ? <Check className="size-[18px]" strokeWidth={2.2} aria-hidden /> : <Copy className="size-[18px]" strokeWidth={1.9} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
        <span role="status" className="sr-only">
          {copied ? "Copied" : ""}
        </span>
      </div>
    </div>,
    document.body,
  );
}

/** A reaction chip: tap toggles it; a long-press (touch) or right-click
 * calls `onHold` (who reacted with this). Stops the press reaching the
 * message's own long-press. */
export function ReactionChip({
  onToggle,
  onHold,
  className,
  children,
  ...aria
}: {
  onToggle: () => void;
  onHold?: () => void;
  className?: string;
  children: React.ReactNode;
  "aria-label": string;
  "aria-pressed": boolean;
}) {
  const lp = useTouchLongPress(() => onHold?.(), !!onHold);
  return (
    <button
      type="button"
      {...aria}
      title={onHold ? "Long-press or right-click to see who reacted" : undefined}
      onClick={() => {
        if (lp.firedRef.current) return;
        onToggle();
      }}
      onContextMenu={
        onHold
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!lp.firedRef.current) onHold();
            }
          : undefined
      }
      onPointerDown={(e) => {
        e.stopPropagation();
        lp.handlers.onPointerDown(e);
      }}
      onPointerMove={lp.handlers.onPointerMove}
      onPointerUp={lp.handlers.onPointerUp}
      onPointerCancel={lp.handlers.onPointerCancel}
      style={{ WebkitTouchCallout: "none" }}
      className={className}
    >
      {children}
    </button>
  );
}

/** True when the click that just came in was the one that dismissed an open action menu. The
 *  pointerdown (capture, before any handler) records whether a menu was open; the click after it
 *  consumes that flag, so the message under the press doesn't open its own menu too. */
let menuWasOpenAtPress = false;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    () => {
      menuWasOpenAtPress = !!document.querySelector('[role="menu"], [data-transient-overlay]');
    },
    true,
  );
}
export function consumeMenuDismissClick(): boolean {
  const was = menuWasOpenAtPress;
  menuWasOpenAtPress = false;
  return was;
}
