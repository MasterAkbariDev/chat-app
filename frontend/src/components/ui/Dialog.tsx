"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useBackToClose } from "@/hooks/use-back-to-close";
import { cn } from "@/lib/cn";

export interface DialogProps {
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Sticky action row at the bottom (buttons). */
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  /** Hide the × button (e.g. a blocking confirm). Esc/backdrop still close
   * unless `dismissible` is false. */
  hideClose?: boolean;
  dismissible?: boolean;
  /** Render as <form> so Enter submits and the footer's submit button works. */
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;
  className?: string;
  bodyClassName?: string;
  /** Accessible name when there's no visible `title`. */
  "aria-label"?: string;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Open dialogs, bottom to top. Only the topmost one handles Esc and traps
// Tab, so a confirm opened over another dialog closes on its own.
const dialogStack: symbol[] = [];

/** The one modal primitive: portal to <body>, scrim, focus moves in on open
 * and is trapped inside, Esc/backdrop close, focus returns to whatever
 * opened it, the page behind stops scrolling, and the system/browser back
 * button closes it (hooks/use-back-to-close). Renders as a bottom
 * sheet on phones and a centred card from `sm` up. Callers mount it
 * conditionally (`{open ? <Dialog …/> : null}`). */
export function Dialog({
  onClose,
  title,
  description,
  children,
  footer,
  size = "sm",
  hideClose,
  dismissible = true,
  onSubmit,
  className,
  bodyClassName,
  "aria-label": ariaLabel,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  // Captured during the first render — before React's own `autoFocus`
  // handling (which runs during commit, ahead of any effect) moves focus
  // into the dialog — so closing returns focus to whatever opened it.
  const [returnFocusTo] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const onCloseRef = useRef(onClose);
  // Read through a ref so a caller toggling `dismissible` (e.g. while a
  // request is pending) doesn't re-run the mount effect below — that used
  // to bounce focus out to the opener and back onto the first field.
  const dismissibleRef = useRef(dismissible);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });
  // The phone's back button/gesture closes the dialog instead of leaving
  // the page (a blocking one stays put).
  useBackToClose(() => {
    if (!dismissibleRef.current) return false;
    onCloseRef.current();
  });

  useEffect(() => {
    const token = Symbol("dialog");
    dialogStack.push(token);
    const panel = panelRef.current;
    // Prefer an explicitly autofocused field, then the first form control,
    // then the panel itself — never the × button, which would make Enter close.
    const target =
      panel?.querySelector<HTMLElement>("[autofocus],[data-autofocus]") ??
      panel?.querySelector<HTMLElement>("input:not([type=hidden]),textarea,select") ??
      panel;
    target?.focus({ preventScroll: true });

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (!panelRef.current || dialogStack[dialogStack.length - 1] !== token) return;
      // A Menu opened from inside the dialog handles its own keys.
      if ((e.target as HTMLElement | null)?.closest?.('[role="menu"]')) return;
      if (e.key === "Escape") {
        // Swallow Esc either way so nothing underneath (a menu, the
        // conversation's own Esc handling) reacts to it too.
        e.stopImmediatePropagation();
        if (dismissibleRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Roving-tabindex groups (SegmentedTabs, radio grids) keep their
      // non-selected items at tabIndex -1 — those aren't Tab stops.
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.tabIndex >= 0 && n.offsetParent !== null);
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      // Focus can end up outside the panel without a Tab — the focused
      // control was removed or disabled while the dialog's content swapped
      // (a form turning into its success state, a button going disabled
      // mid-request) — and the browser then Tabs from <body> into the page
      // behind the scrim. Pull it back in.
      if (!panelRef.current.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const idx = dialogStack.indexOf(token);
      if (idx >= 0) dialogStack.splice(idx, 1);
      if (dialogStack.length === 0) document.body.style.overflow = prevOverflow;
      if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  if (typeof document === "undefined") return null;

  const content = (
    <>
          <div aria-hidden className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line-strong sm:hidden" />
          {title || !hideClose ? (
            <div className="flex shrink-0 items-start gap-3 px-5 pb-1 pt-4 sm:pt-5">
              <div className="min-w-0 flex-1">
                {title ? (
                  <h2 id={titleId} className="text-[18px] font-bold leading-snug text-fg">
                    {title}
                  </h2>
                ) : null}
                {description ? (
                  <p id={descId} className="mt-1 text-[14px] leading-relaxed text-muted">
                    {description}
                  </p>
                ) : null}
              </div>
              {!hideClose ? (
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => onCloseRef.current()}
                  className="pressable -me-1.5 -mt-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-fg"
                >
                  <X className="size-[18px]" strokeWidth={2} />
                </button>
              ) : null}
            </div>
          ) : null}
          <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-3", bodyClassName)}>{children}</div>
          {footer ? (
            // Not `.safe-bottom`: that global class is unlayered, so it beats
            // Tailwind's `py-4` and zeroed the footer's bottom padding
            // wherever there's no home indicator (every desktop browser).
            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-line px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 sm:flex-row sm:justify-end">
              {footer}
            </div>
          ) : (
            <div className="safe-bottom h-2 shrink-0" />
          )}
    </>
  );

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-6">
      <div
        aria-hidden
        className="fade-in absolute inset-0 bg-[var(--scrim)]"
        onClick={dismissible ? () => onCloseRef.current() : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        className={cn(
          // `.sheet-up`/`.pop-in` are plain (unlayered) classes, so `sm:pop-in`
          // never applied and desktop got the phone's slide-up — use the
          // keyframes through Tailwind's breakpoint variants instead.
          "relative max-sm:animate-[sheet-up_var(--dur-slow)_var(--ease-out)_both] sm:animate-[pop-in_var(--dur-base)_var(--ease-out)_both]",
          "flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[var(--radius-lg)] border border-line bg-raised shadow-lg outline-none sm:rounded-[var(--radius-lg)]",
          size === "sm" && "sm:max-w-[420px]",
          size === "md" && "sm:max-w-[520px]",
          size === "lg" && "sm:max-w-[680px]",
          className,
        )}
      >
        {onSubmit ? (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(e);
            }}
          >
            {content}
          </form>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">{content}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A two-button confirm built on Dialog — for destructive or irreversible
 * actions ("Block", "Leave group", "Delete for everyone"). */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive,
  pending,
  onConfirm,
  onClose,
}: {
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      onClose={onClose}
      title={title}
      description={description}
      hideClose
      bodyClassName="hidden"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            data-autofocus={destructive ? true : undefined}
            className="pressable h-11 rounded-[var(--radius-sm)] border border-line bg-sunken px-4 text-[15px] font-semibold text-fg hover:border-line-strong"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-autofocus={destructive ? undefined : true}
            disabled={pending}
            onClick={onConfirm}
            className={cn(
              "pressable inline-flex h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] px-4 text-[15px] font-semibold disabled:opacity-60",
              destructive ? "bg-danger text-canvas hover:brightness-110" : "bg-accent text-accent-fg hover:bg-accent-hover",
            )}
          >
            {pending ? <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : null}
            {confirmLabel}
          </button>
        </>
      }
    />
  );
}
