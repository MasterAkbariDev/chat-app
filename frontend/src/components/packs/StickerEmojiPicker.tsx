"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, ImagePlus, Search, Settings2, Trash2, X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { useRouter } from "@/hooks/use-app-router";
import { PackPreviewSheet } from "@/components/packs/PackPreviewSheet";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useBackToClose } from "@/hooks/use-back-to-close";
import { EMOJI_CATEGORIES } from "@/lib/emoji-data";
import { getMyPacks, getPack, searchPackItems, searchPacks } from "@/lib/api/packs";
import { addRecentEmoji, getRecentEmoji, type RecentEmojiEntry } from "@/lib/api/users";
import { cn } from "@/lib/cn";
import { smoothScroll } from "@/lib/performance";
import { PackImage } from "@/components/packs/PackImage";
import { GifImage } from "@/components/media/GifImage";
import { useLongPress } from "@/components/ui/Menu";
import { ApiError } from "@/lib/api/client";
import {
  getSavedGifs,
  markSavedGifUsed,
  mirrorGiphyGif,
  removeSavedGif,
  SAVED_GIFS_KEY,
  searchGiphy,
  trendingGiphy,
  uploadSavedGif,
  type GiphyHit,
  type SavedGif,
} from "@/lib/api/gifs";
import { resolveMediaUrl } from "@/lib/media-url";
import type { PackItem, PackType } from "@/lib/api/types";

export type SendItemHandler = (
  packId: string,
  itemId: string,
  relativePath: string,
  extra?: { keywords: string[]; type?: PackType; thumbPath?: string; stillPath?: string },
) => void;

/** An animated emoji picked for *inline* use (it goes into the message text,
 * not out as its own message). `fallback` is the unicode emoji stored in the
 * text in its place. */
export interface AnimatedEmojiPick {
  packId: string;
  packItemId: string;
  /** Small animated variant (falls back to the original on older servers). */
  relativePath: string;
  /** First-frame still, when the item has one. */
  stillPath?: string;
  fallback: string;
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/** The item's first keyword that is itself an emoji (packs tag items with
 * their emoji, e.g. ["😂", "lol"]); a sparkle when none is. */
export function fallbackEmojiFor(keywords: string[]): string {
  return keywords.find((k) => PICTOGRAPHIC.test(k) && [...k].length <= 8) ?? "✨";
}

/** A GIF picked to send as its own message. `mediaId` is set for one from
 * your saved library (lets the server attach width/height/blurhash). */
export interface GifPick {
  url: string;
  mediaId?: string;
}

type Tab = "emoji" | "animated" | "stickers" | "gifs";

const TABS: { key: Tab; label: string }[] = [
  { key: "emoji", label: "Emoji" },
  { key: "animated", label: "Animated" },
  { key: "stickers", label: "Stickers" },
  { key: "gifs", label: "GIFs" },
];

const PANEL_W = 340;
const PANEL_H = 380;
const GAP = 8;
const EDGE = 8;
const PHONE_MAX = 640;

export interface StickerEmojiPickerProps {
  onSendEmoji: (char: string) => void;
  onSendItem: SendItemHandler;
  onClose: () => void;
  /** Move focus into the panel when it opens. The composer turns this off so the keyboard stays up. */
  autoFocus?: boolean;
  /** Which side of the trigger to open on. The Composer (bottom of the
   *  screen) always has room above, so it doesn't pass this — default "up"
   *  keeps its exact prior behavior. A trigger that can sit anywhere in a
   *  scrollable list (e.g. a message's "add reaction" button) needs to flip
   *  to "down" when opening up would push this 380px-tall panel above the
   *  viewport entirely. */
  placement?: "up" | "down";
  /** When given, animated emoji are inserted into the text via this instead
   *  of being sent as their own message, and the picker stays open (like the
   *  regular emoji tab). Stickers are always sent on their own. */
  onInsertAnimated?: (pick: AnimatedEmojiPick) => void;
  /** False hides the Stickers and GIFs tabs and refuses to send stickers (e.g.
   *  you aren't allowed to send stickers and GIFs in this group). Default true. */
  allowStickers?: boolean;
  /** Given → a GIFs tab (your saved library, add from device, and Giphy
   *  search when the server has it). Picking one sends it and closes. */
  onSendGif?: (gif: GifPick) => void;
}

type PanelPos = { left: number; width: number; height: number } & ({ top: number } | { bottom: number });

/** Positions the panel against the element the picker is rendered inside
 * (the call site's `relative` wrapper — same contract as the old
 * `absolute bottom-full end-0` panel), but portalled and `fixed` so a
 * scrolling message list or an `overflow-hidden` ancestor can never clip
 * it. End-aligned to the wrapper on wide screens; full-width (8px gutters)
 * on phones. */
function computePosition(anchor: DOMRect, placement: "up" | "down"): PanelPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rtl = document.documentElement.dir === "rtl";
  const phone = vw < PHONE_MAX;
  const width = phone ? vw - EDGE * 2 : Math.min(PANEL_W, vw - EDGE * 2);
  let left = phone ? EDGE : rtl ? anchor.left : anchor.right - width;
  left = Math.max(EDGE, Math.min(left, vw - width - EDGE));

  const roomAbove = anchor.top - GAP - EDGE;
  const roomBelow = vh - anchor.bottom - GAP - EDGE;
  // Honour the caller's placement unless that side genuinely can't fit a
  // usable panel and the other side has more room.
  let side = placement;
  if (side === "up" && roomAbove < 240 && roomBelow > roomAbove) side = "down";
  if (side === "down" && roomBelow < 240 && roomAbove > roomBelow) side = "up";
  const height = Math.max(200, Math.min(PANEL_H, side === "up" ? roomAbove : roomBelow));
  return side === "up"
    ? { left, width, height, bottom: vh - anchor.top + GAP }
    : { left, width, height, top: anchor.bottom + GAP };
}

// Base emoji (unicode, client-side, zero backend calls) plus two pack-backed
// tabs (animated emoji, stickers) — structurally identical to each other,
// per docs/PACKS_AND_BOTS_FRONTEND_BRIEF.md. Neither pack tab shows
// anything the user hasn't added to their own collection.
export function StickerEmojiPicker({ onSendEmoji, onSendItem, onClose, placement = "up", onInsertAnimated, allowStickers = true, onSendGif, autoFocus = true }: StickerEmojiPickerProps) {
  const tabs = TABS.filter((t) => (t.key === "stickers" ? allowStickers : t.key === "gifs" ? allowStickers && !!onSendGif : true));
  /** Returns true when the item was *sent* (so the picker should close). */
  const route = (
    packId: string,
    itemId: string,
    relativePath: string,
    extra?: { keywords: string[]; type?: PackType; thumbPath?: string; stillPath?: string },
  ): boolean => {
    if (extra?.type === "emoji") {
      const pick: AnimatedEmojiPick = {
        packId,
        packItemId: itemId,
        relativePath: extra.thumbPath ?? relativePath,
        stillPath: extra.stillPath,
        fallback: fallbackEmojiFor(extra.keywords),
      };
      recordAnimated(pick);
      if (onInsertAnimated) {
        onInsertAnimated(pick);
        return false;
      }
    }
    if (!allowStickers && extra?.type !== "emoji") return false;
    onSendItem(packId, itemId, relativePath, extra);
    return true;
  };
  const qc = useQueryClient();
  const recentKey = ["recent-emoji"] as const;
  const recentQuery = useQuery({ queryKey: recentKey, queryFn: getRecentEmoji, staleTime: 60_000 });
  const recent = recentQuery.data ?? [];
  const recordMutation = useMutation({
    mutationFn: (input: { emoji: string } | { packItemId: string }) => addRecentEmoji(input),
    onSuccess: (list) => qc.setQueryData(recentKey, list),
  });
  /** Puts a pick at the front of the recent list now, and saves it on the server. */
  function recordRecent(entry: RecentEmojiEntry, input: { emoji: string } | { packItemId: string }) {
    qc.setQueryData<RecentEmojiEntry[]>(recentKey, (prev) => [entry, ...(prev ?? []).filter((e) => e.key !== entry.key)].slice(0, RECENT_SHOWN));
    recordMutation.mutate(input);
  }
  function recordAnimated(pick: AnimatedEmojiPick) {
    recordRecent(
      {
        key: `a:${pick.packItemId}`,
        emoji: null,
        fallback: pick.fallback,
        item: { packItemId: pick.packItemId, packId: pick.packId, relativePath: pick.relativePath, thumbPath: pick.relativePath, stillPath: pick.stillPath ?? "" },
      },
      { packItemId: pick.packItemId },
    );
  }
  function pickChar(char: string) {
    onSendEmoji(char);
    recordRecent({ key: `u:${char}`, emoji: char, fallback: char, item: null }, { emoji: char });
  }
  /** A pick from the Recent section: a plain emoji, or an animated one (inline when the Composer
   *  takes it, otherwise sent as its own message like from the pack tab). */
  function pickRecent(entry: RecentEmojiEntry) {
    if (entry.emoji != null) {
      pickChar(entry.emoji);
      return;
    }
    const item = entry.item;
    if (!item) return;
    const pick: AnimatedEmojiPick = {
      packId: item.packId,
      packItemId: item.packItemId,
      relativePath: item.thumbPath || item.relativePath,
      stillPath: item.stillPath || undefined,
      fallback: entry.fallback,
    };
    recordRecent(entry, { packItemId: item.packItemId });
    if (onInsertAnimated) {
      onInsertAnimated(pick);
      return;
    }
    onSendItem(item.packId, item.packItemId, item.relativePath, { keywords: [], type: "emoji", thumbPath: item.thumbPath, stillPath: item.stillPath || undefined });
    onClose();
  }
  const [tab, setTab] = useState<Tab>("emoji");
  const [previewPackId, setPreviewPackId] = useState<string | null>(null);
  const router = useRouter();
  const [pos, setPos] = useState<PanelPos | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  const onCloseRef = useRef(onClose);
  // While a pack preview (a portalled Dialog) is
  // open on top, Esc and clicks belong to that dialog, not this popover.
  const subOverlayOpen = previewPackId !== null;
  const subOverlayRef = useRef(subOverlayOpen);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    subOverlayRef.current = subOverlayOpen;
  });
  // Back closes the picker (a pack preview open on top closes first — it's
  // higher on the overlay stack).
  useBackToClose(() => onCloseRef.current());

  const reposition = useCallback(() => {
    const wrapper = anchorRef.current?.parentElement;
    if (!wrapper) return;
    setPos(computePosition(wrapper.getBoundingClientRect(), placement));
  }, [placement]);

  useLayoutEffect(() => {
    reposition();
  }, [reposition]);

  useEffect(() => {
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [reposition]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    function onPointerDown(e: PointerEvent) {
      if (subOverlayRef.current) return;
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      // The wrapper holds the trigger button — let its own onClick toggle
      // the picker instead of closing here and immediately reopening.
      if (anchorRef.current?.parentElement?.contains(target)) return;
      onCloseRef.current();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || subOverlayRef.current) return;
      e.stopPropagation();
      onCloseRef.current();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  // Move focus in once the panel is actually positioned — before that it's
  // `invisible` (visibility: hidden), which can't take focus.
  const placed = pos !== null;
  useEffect(() => {
    if (placed && autoFocus) tabRefs.current[0]?.focus({ preventScroll: true });
  }, [placed, autoFocus]);

  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    let next: number | null = null;
    const rtl = document.documentElement.dir === "rtl";
    if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = (index + 1) % tabs.length;
    else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    setTab(tabs[next].key);
    tabRefs.current[next]?.focus();
  }

  const panelStyle: React.CSSProperties = pos
    ? { left: pos.left, width: pos.width, height: pos.height, ...("top" in pos ? { top: pos.top } : { bottom: pos.bottom }) }
    : { left: 0, top: 0, width: PANEL_W, height: PANEL_H };

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      data-transient-overlay=""
      aria-label={onSendGif && allowStickers ? "Emoji, stickers and GIFs" : "Emoji and stickers"}
      style={panelStyle}
      className={cn(
        "fixed z-[60] flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-raised shadow-lg",
        pos ? "pop-in" : "invisible",
      )}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-2">
        <div role="tablist" aria-label="Picker sections" className="flex min-w-0 flex-1 items-center gap-1">
          {tabs.map((t, i) => {
            const selected = tab === t.key;
            return (
              <button
                key={t.key}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.key}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(t.key)}
                onKeyDown={(e) => onTabKeyDown(e, i)}
                className={cn(
                  "pressable h-9 rounded-full px-3.5 text-[13.5px] font-semibold",
                  selected ? "bg-accent-soft text-accent-text" : "text-fg-2 hover:bg-sunken hover:text-fg",
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <IconButton aria-label="Close" size="sm" onClick={onClose}>
          <X strokeWidth={2} aria-hidden />
        </IconButton>
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === "emoji" ? (
          <EmojiTab onPick={pickChar} recent={recent} onPickRecent={pickRecent} />
        ) : tab === "gifs" && onSendGif ? (
          <GifTab
            onPick={(gif) => {
              onSendGif(gif);
              onClose();
            }}
          />
        ) : (
          <PackTab
            key={tab}
            type={tab === "animated" ? "emoji" : "sticker"}
            onSendItem={(packId, itemId, relativePath, extra) => {
              if (route(packId, itemId, relativePath, { ...extra, keywords: extra?.keywords ?? [], type: tab === "animated" ? "emoji" : "sticker" })) onClose();
            }}
            onPreview={setPreviewPackId}
            onManage={() => {
              onClose();
              router.push("/app/settings/packs");
            }}
          />
        )}
      </div>
    </div>
  );

  return (
    <>
      <span ref={anchorRef} aria-hidden className="hidden" />
      {typeof document !== "undefined" ? createPortal(panel, document.body) : null}

      {previewPackId ? (
        <PackPreviewSheet
          packId={previewPackId}
          onClose={() => setPreviewPackId(null)}
          onSendItem={(packId, itemId, relativePath, extra) => {
            if (route(packId, itemId, relativePath, extra)) {
              setPreviewPackId(null);
              onClose();
            }
          }}
        />
      ) : null}

    </>
  );
}

/** Roving-tabindex arrow-key navigation for a grid of buttons — one tab
 * stop per grid, arrows move by geometry (so rows split into category
 * sections still move naturally up/down), Home/End jump to the ends. */
function useRovingGrid() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  function onKeyDown(e: React.KeyboardEvent) {
    const items = Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-grid-item]") ?? []);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (idx < 0) return;
    const rtl = document.documentElement.dir === "rtl";
    let next = -1;
    if (e.key === "ArrowRight") next = rtl ? idx - 1 : idx + 1;
    else if (e.key === "ArrowLeft") next = rtl ? idx + 1 : idx - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const cur = items[idx].getBoundingClientRect();
      const down = e.key === "ArrowDown";
      let best = -1;
      let bestScore = Infinity;
      items.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const dy = down ? r.top - cur.top : cur.top - r.top;
        if (dy <= 1) return;
        const score = dy * 1000 + Math.abs(r.left - cur.left);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      });
      next = best;
    } else return;
    e.preventDefault();
    if (next < 0 || next >= items.length) return;
    setActive(next);
    items[next].focus();
    items[next].scrollIntoView({ block: "nearest" });
  }

  const itemProps = (index: number) => ({
    "data-grid-item": true,
    tabIndex: index === active ? 0 : -1,
    onFocus: () => setActive(index),
  });

  return { containerRef, onKeyDown, itemProps };
}

/** Scroll-spy for a picker tab: which `[data-section]` is at the top of the
 * scroller, and a jump that scrolls a section to the top. The scroller must
 * be `position: relative` so section `offsetTop`s are measured against it.
 *
 * A jump marks its section active immediately and holds it there while its
 * own (short, ~140 ms) scroll runs — the scroll-spy is paused until it lands,
 * so the highlight never flickers through the sections in between. Any
 * scrolling of your own (wheel, touch, keys) cancels the jump and hands the
 * highlight back to the scroll-spy. */
const JUMP_MS = 140;
const FAR_JUMP_PX = 2400;
function useSectionJump() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const lockRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  const sync = useCallback(() => {
    if (lockRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    let current: string | null = null;
    // At the very bottom a short last section can never reach the top, so
    // count anything already on screen as "reached".
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    const line = atBottom ? el.scrollTop + el.clientHeight - 24 : el.scrollTop + 12;
    for (const section of Array.from(el.querySelectorAll<HTMLElement>("[data-section]"))) {
      if (section.offsetTop <= line) current = section.dataset.section ?? null;
      else break;
    }
    setActive(current ?? el.querySelector<HTMLElement>("[data-section]")?.dataset.section ?? null);
  }, []);

  const stopJump = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    lockRef.current = false;
  }, []);

  // The user taking over the scroll ends a running jump.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const takeOver = () => {
      if (!lockRef.current) return;
      stopJump();
      sync();
    };
    el.addEventListener("wheel", takeOver, { passive: true });
    el.addEventListener("touchstart", takeOver, { passive: true });
    el.addEventListener("keydown", takeOver);
    return () => {
      el.removeEventListener("wheel", takeOver);
      el.removeEventListener("touchstart", takeOver);
      el.removeEventListener("keydown", takeOver);
      stopJump();
    };
  }, [stopJump, sync]);

  const jump = useCallback(
    (id: string) => {
      const el = scrollRef.current;
      const section = el?.querySelector<HTMLElement>(`[data-section="${CSS.escape(id)}"]`);
      if (!el || !section) return;
      stopJump();
      setActive(id);
      const target = Math.min(Math.max(0, section.offsetTop - 4), el.scrollHeight - el.clientHeight);
      const from = el.scrollTop;
      const distance = target - from;
      if (Math.abs(distance) < 1) return;
      lockRef.current = true;
      // Reduced motion, or far enough that animating would just blur past
      // content: land instantly.
      if (smoothScroll() === "auto" || Math.abs(distance) > FAR_JUMP_PX) {
        el.scrollTop = target;
        // Let the resulting scroll event pass before the spy resumes.
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          lockRef.current = false;
        });
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / JUMP_MS);
        el.scrollTop = from + distance * (1 - Math.pow(1 - t, 3));
        if (t < 1) frameRef.current = requestAnimationFrame(step);
        else
          frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            lockRef.current = false;
          });
      };
      frameRef.current = requestAnimationFrame(step);
    },
    [stopJump],
  );

  return { scrollRef, active, sync, jump };
}

interface SectionNavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

/** The row of jump buttons above a tab's content — one per section (emoji
 * category or pack), showing that section's first item. */
function SectionNav({
  items,
  active,
  onJump,
  trailing,
}: {
  items: SectionNavItem[];
  active: string | null;
  onJump: (id: string) => void;
  trailing?: React.ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // Keep the highlighted button in view as the content scrolls.
  useEffect(() => {
    if (!active) return;
    // Horizontal only, on the strip itself — scrollIntoView could also move
    // the page or the picker's content scroller.
    const row = rowRef.current;
    const btn = row?.querySelector<HTMLElement>(`[data-nav="${CSS.escape(active)}"]`);
    if (!row || !btn) return;
    const r = row.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    if (b.left < r.left) row.scrollLeft -= r.left - b.left + 8;
    else if (b.right > r.right) row.scrollLeft += b.right - r.right + 8;
  }, [active]);

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
      <div ref={rowRef} role="toolbar" aria-label="Jump to section" className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          const on = item.id === active;
          return (
            <button
              key={item.id}
              type="button"
              data-nav={item.id}
              aria-label={`Jump to ${item.label}`}
              aria-current={on ? "true" : undefined}
              title={item.label}
              onClick={() => onJump(item.id)}
              className={cn(
                "pressable flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[20px] leading-none",
                on ? "bg-accent-soft ring-1 ring-accent/40" : "opacity-70 hover:bg-sunken hover:opacity-100",
              )}
            >
              {item.icon}
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}

/** How many recent emoji the picker shows (the server keeps the same cap). */
const RECENT_SHOWN = 30;

function EmojiTab({ onPick, recent, onPickRecent }: { onPick: (char: string) => void; recent: RecentEmojiEntry[]; onPickRecent: (entry: RecentEmojiEntry) => void }) {
  const { scrollRef, active, sync, jump } = useSectionJump();
  const hasRecent = recent.length > 0;
  const items = [
    ...(hasRecent ? [{ id: "Recent", label: "Recent", icon: <Clock className="size-4" strokeWidth={1.8} aria-hidden /> }] : []),
    ...EMOJI_CATEGORIES.map((c) => ({ id: c.label, label: c.label, icon: <span aria-hidden>{c.emoji[0]}</span> })),
  ];
  return (
    <>
      <SectionNav items={items} active={active ?? (hasRecent ? "Recent" : EMOJI_CATEGORIES[0]?.label ?? null)} onJump={jump} />
      <div ref={scrollRef} onScroll={sync} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <BaseEmojiGrid onPick={onPick} leading={hasRecent ? <RecentEmojiSection entries={recent} onPick={onPickRecent} /> : null} />
      </div>
    </>
  );
}

/** The Recent section: your latest plain and animated emoji, newest first. */
function RecentEmojiSection({ entries, onPick }: { entries: RecentEmojiEntry[]; onPick: (entry: RecentEmojiEntry) => void }) {
  return (
    <section aria-label="Recent" data-section="Recent">
      <h3 className="sticky top-0 z-[1] -mx-3 bg-raised px-3 py-1.5 text-[12.5px] font-semibold text-muted">Recent</h3>
      <div className="grid grid-cols-8 gap-0.5">
        {entries.map((entry) => {
          if (entry.emoji != null) {
            return (
              <button
                key={entry.key}
                type="button"
                aria-label={entry.emoji}
                onClick={() => onPick(entry)}
                className="pressable flex aspect-square w-full items-center justify-center rounded-[var(--radius-sm)] text-[22px] leading-none hover:bg-sunken focus-visible:bg-sunken"
              >
                <span aria-hidden>{entry.emoji}</span>
              </button>
            );
          }
          const item = entry.item;
          if (!item) return null;
          return (
            <button
              key={entry.key}
              type="button"
              aria-label={`Animated emoji: ${entry.fallback}`}
              title="Animated emoji"
              onClick={() => onPick(entry)}
              className="pressable flex aspect-square items-center justify-center rounded-[var(--radius-sm)] hover:bg-sunken focus-visible:bg-sunken"
            >
              {/* The same box as a text emoji (22px glyph), so animated and plain ones read the same size. */}
              <span className="flex size-[26px] items-center justify-center">
                <PackImage thumbPath={item.thumbPath || item.relativePath} stillPath={item.stillPath || null} alt="" className="size-full object-contain" />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function BaseEmojiGrid({
  onPick,
  selected,
  headingTopClass = "top-0",
  leading,
}: {
  onPick: (char: string) => void;
  /** Marks this emoji as the current choice (e.g. the quick reaction). */
  selected?: string | null;
  /** Where the sticky category headings stop (below a sticky bar above the grid). */
  headingTopClass?: string;
  /** Content above the categories (the picker's Recent section). */
  leading?: React.ReactNode;
}) {
  const { containerRef, onKeyDown, itemProps } = useRovingGrid();
  let index = 0;
  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="flex flex-col gap-4 px-3 pb-3 pt-2">
      {leading}
      {EMOJI_CATEGORIES.map((cat) => (
        <section key={cat.label} aria-label={cat.label} data-section={cat.label}>
          <h3 className={cn("sticky z-[1] -mx-3 bg-raised px-3 py-1.5 text-[12.5px] font-semibold text-muted", headingTopClass)}>{cat.label}</h3>
          <div className="grid grid-cols-8 gap-0.5">
            {cat.emoji.map((e) => {
              const i = index++;
              return (
                <button
                  key={e}
                  type="button"
                  aria-label={e}
                  aria-pressed={selected != null ? selected === e : undefined}
                  onClick={() => onPick(e)}
                  {...itemProps(i)}
                  className={cn(
                    "pressable flex aspect-square w-full items-center justify-center rounded-[var(--radius-sm)] text-[22px] leading-none hover:bg-sunken focus-visible:bg-sunken",
                    selected === e && "bg-accent-soft ring-1 ring-accent/40",
                  )}
                >
                  <span aria-hidden>{e}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function itemLabel(item: Pick<PackItem, "keywords">, kind: PackType) {
  const words = item.keywords.slice(0, 3).join(", ");
  const noun = kind === "sticker" ? "Sticker" : "Animated emoji";
  return words ? `${noun}: ${words}` : noun;
}

function PackItemButton({
  item,
  label,
  onClick,
  gridProps,
  compact,
}: {
  item: Pick<PackItem, "relativePath" | "thumbPath" | "stillPath">;
  label: string;
  onClick: () => void;
  gridProps: ReturnType<ReturnType<typeof useRovingGrid>["itemProps"]>;
  /** Animated-emoji grid: small cells like the regular emoji grid. */
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      {...gridProps}
      className={cn(
        "pressable flex aspect-square items-center justify-center overflow-hidden rounded-[var(--radius-sm)] hover:bg-line focus-visible:bg-line",
        compact ? "p-1 hover:bg-sunken focus-visible:bg-sunken" : "bg-sunken p-1.5",
      )}
    >
      <PackImage thumbPath={item.thumbPath ?? item.relativePath} stillPath={item.stillPath} alt="" className="size-full object-contain" />
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="px-1 text-[12.5px] font-semibold text-muted">{children}</h3>;
}

function PackTab({
  type,
  onSendItem,
  onPreview,
  onManage,
}: {
  type: PackType;
  onSendItem: SendItemHandler;
  onPreview: (packId: string) => void;
  onManage: () => void;
}) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const searching = debouncedQuery.length >= 2;
  const { containerRef, onKeyDown, itemProps } = useRovingGrid();
  const { scrollRef, active, sync, jump } = useSectionJump();
  const noun = type === "sticker" ? "sticker" : "animated emoji";
  const compact = type === "emoji";
  const gridCols = compact ? "grid-cols-7 gap-1" : "grid-cols-4 gap-1.5";

  const mineQuery = useQuery({ queryKey: ["packs", "mine", type], queryFn: () => getMyPacks(type) });

  const itemSearchQuery = useQuery({
    queryKey: ["packs", "search-items", type, debouncedQuery],
    queryFn: () => searchPackItems(debouncedQuery, type),
    enabled: searching,
  });

  const discoverQuery = useQuery({
    queryKey: ["packs", "discover", type, debouncedQuery],
    queryFn: () => searchPacks(debouncedQuery, type),
    enabled: searching,
  });

  // GET /v1/packs/search-items 500s on an empty query, so there's no single
  // endpoint for "show everything I own" — fetch each owned pack's full
  // detail (items) in parallel instead, for the default (non-search) view.
  const mine = mineQuery.data ?? [];
  const detailQueries = useQueries({
    queries: mine.map((pack) => ({
      queryKey: ["packs", "detail", pack.id],
      queryFn: () => getPack(pack.id),
      enabled: !searching,
    })),
  });

  let gridIndex = 0;
  const hits = itemSearchQuery.data ?? [];
  const discovered = discoverQuery.data ?? [];

  const navItems: SectionNavItem[] = mine.map((pack, i) => {
    const first = detailQueries[i]?.data?.items[0];
    return {
      id: pack.id,
      label: pack.name,
      icon: first ? (
        // Nav icons never animate — a row of moving thumbnails is noise.
        <PackImage thumbPath={first.stillPath ?? first.thumbPath ?? first.relativePath} alt="" className="size-7 object-contain" />
      ) : (
        <span aria-hidden className="text-[13px] font-bold text-muted">{pack.name.slice(0, 1).toUpperCase()}</span>
      ),
    };
  });

  return (
    <>
    <SectionNav
      items={searching ? [] : navItems}
      active={active ?? mine[0]?.id ?? null}
      onJump={jump}
      trailing={
        <IconButton aria-label="Manage packs" size="sm" onClick={onManage}>
          <Settings2 strokeWidth={1.8} aria-hidden />
        </IconButton>
      }
    />
    <div ref={scrollRef} onScroll={sync} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <div className="flex min-h-full flex-col gap-3 p-3">
      <label className="flex h-10 shrink-0 items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-sunken px-3 text-muted transition-colors focus-within:border-accent focus-within:bg-raised hover:border-line-strong">
        <Search className="size-[17px] shrink-0" strokeWidth={1.8} aria-hidden />
        <span className="sr-only">Search {noun} packs</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${noun}s`}
          autoComplete="off"
          // Focus is shown on the wrapper (focus-within accent border) —
          // the global ring would otherwise draw a second box inside it.
          style={{ outline: "none" }}
          className="h-full w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-muted focus-visible:outline-none"
        />
      </label>

      <div ref={containerRef} onKeyDown={onKeyDown} className="flex flex-col gap-4">
        {searching ? (
          <>
            {itemSearchQuery.isPending ? (
              <div className={cn("grid", gridCols)} aria-hidden>
                {Array.from({ length: compact ? 14 : 8 }, (_, i) => (
                  <Skeleton key={i} className="aspect-square rounded-[var(--radius-sm)]" />
                ))}
              </div>
            ) : hits.length > 0 ? (
              <section className="flex flex-col gap-1.5" aria-label="Matching items">
                <SectionLabel>In your packs</SectionLabel>
                <div className={cn("grid", gridCols)}>
                  {hits.map((hit) => (
                    <PackItemButton
                      key={hit.id}
                      item={hit}
                      compact={compact}
                      label={itemLabel(hit, type)}
                      onClick={() => onSendItem(hit.packId, hit.id, hit.relativePath, { keywords: hit.keywords, type, thumbPath: hit.thumbPath, stillPath: hit.stillPath })}
                      gridProps={itemProps(gridIndex++)}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            <section className="flex flex-col gap-1" aria-label="Discover packs">
              <SectionLabel>Discover packs</SectionLabel>
              {discoverQuery.isPending ? (
                <Skeleton className="h-12 rounded-[var(--radius-sm)]" />
              ) : discoverQuery.isError || itemSearchQuery.isError ? (
                <p className="px-1 py-2 text-[13.5px] text-danger">Search didn&apos;t load. Check your connection and try again.</p>
              ) : discovered.length === 0 ? (
                <p className="px-1 py-2 text-[13.5px] text-muted">No packs match &ldquo;{debouncedQuery}&rdquo;. Try a different word.</p>
              ) : (
                discovered.map((pack) => (
                  <button
                    key={pack.id}
                    type="button"
                    onClick={() => onPreview(pack.id)}
                    className="focus-inset flex min-h-12 items-center gap-3 rounded-[var(--radius-sm)] px-2 py-1.5 text-start hover:bg-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold text-fg">{pack.name}</span>
                      <span className="tabular block text-[12.5px] text-muted">
                        {pack.itemCount} item{pack.itemCount === 1 ? "" : "s"}
                      </span>
                    </span>
                    <span className="shrink-0 text-[13px] font-semibold text-accent-text">Preview</span>
                  </button>
                ))
              )}
            </section>
          </>
        ) : mineQuery.isPending ? (
          <div className={cn("grid", gridCols)} aria-hidden>
            {Array.from({ length: compact ? 14 : 8 }, (_, i) => (
              <Skeleton key={i} className="aspect-square rounded-[var(--radius-sm)]" />
            ))}
          </div>
        ) : mineQuery.isError ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <p className="text-[13.5px] leading-relaxed text-danger">Your {noun} packs didn&apos;t load. Check your connection and try again.</p>
            <button type="button" onClick={() => mineQuery.refetch()} className="pressable rounded-full px-3 py-1.5 text-[13.5px] font-semibold text-accent-text hover:bg-sunken">
              Try again
            </button>
          </div>
        ) : mine.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <div className="text-[15px] font-semibold text-fg">No {noun} packs yet</div>
            <p className="text-[13.5px] leading-relaxed text-muted">Search above to find a pack to add, or make your own from Manage packs (the gear).</p>
          </div>
        ) : (
          mine.map((pack, i) => {
            const items = detailQueries[i]?.data?.items;
            return (
              <section key={pack.id} className="flex flex-col gap-1.5" aria-label={pack.name} data-section={pack.id}>
                <button
                  type="button"
                  onClick={() => onPreview(pack.id)}
                  className="self-start truncate rounded-[var(--radius-xs)] px-1 text-[12.5px] font-semibold text-muted hover:text-fg"
                >
                  {pack.name}
                </button>
                <div className={cn("grid", gridCols)}>
                  {items
                    ? items.map((item) => (
                        <PackItemButton
                          key={item.id}
                          item={item}
                          compact={compact}
                          label={itemLabel(item, type)}
                          onClick={() => onSendItem(pack.id, item.id, item.relativePath, { keywords: item.keywords, type, thumbPath: item.thumbPath, stillPath: item.stillPath })}
                          gridProps={itemProps(gridIndex++)}
                        />
                      ))
                    : detailQueries[i]?.isError
                      ? <p className="col-span-full px-1 text-[13px] text-danger">This pack didn&apos;t load.</p>
                      : Array.from({ length: compact ? 7 : 4 }, (_, k) => <Skeleton key={k} className="aspect-square rounded-[var(--radius-sm)]" />)}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
    </div>
    </>
  );
}

type GifView = "saved" | "search";

/** Saved GIFs (your personal library) + "Add GIF" from the device, and —
 * only when the server has a Giphy key — a Search view. Without Giphy the
 * tab is simply your library; nothing hints at a missing feature. */
function GifTab({ onPick }: { onPick: (gif: GifPick) => void }) {
  const [view, setView] = useState<GifView>("saved");
  // Probe once: the server answers 503 when Giphy isn't configured.
  const trendingQuery = useQuery({
    queryKey: ["gifs", "giphy", "trending"],
    queryFn: () => trendingGiphy(24),
    retry: false,
    staleTime: 10 * 60_000,
  });
  const giphyAvailable = trendingQuery.isSuccess;

  return (
    <>
      {giphyAvailable ? (
        <div role="tablist" aria-label="GIF sections" className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
          {(["saved", "search"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={cn(
                "pressable h-8 rounded-full px-3 text-[13px] font-semibold",
                view === key ? "bg-sunken text-fg" : "text-muted hover:bg-sunken hover:text-fg",
              )}
            >
              {key === "saved" ? "Saved" : "Search"}
            </button>
          ))}
        </div>
      ) : null}
      {view === "search" && giphyAvailable ? (
        <GiphyView trending={trendingQuery.data ?? []} onPick={onPick} />
      ) : (
        <SavedGifsView onPick={onPick} />
      )}
    </>
  );
}

function SavedGifsView({ onPick }: { onPick: (gif: GifPick) => void }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  /** The one tile a long-press / right-click put into "remove?" state. */
  const [armed, setArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { containerRef, onKeyDown, itemProps } = useRovingGrid();

  const savedQuery = useQuery({ queryKey: SAVED_GIFS_KEY, queryFn: () => getSavedGifs() });
  const saved = savedQuery.data ?? [];

  const upload = useMutation({
    mutationFn: (file: File) => uploadSavedGif(file),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: SAVED_GIFS_KEY });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "That GIF didn't upload. Try again."),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeSavedGif(id),
    onMutate: (id) => {
      queryClient.setQueryData<SavedGif[]>(SAVED_GIFS_KEY, (prev) => (prev ?? []).filter((g) => g.id !== id));
      setArmed(null);
    },
    onError: () => setError("Couldn't remove that GIF. Try again."),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SAVED_GIFS_KEY }),
  });

  function send(gif: SavedGif) {
    void markSavedGifUsed(gif.id).catch(() => {});
    onPick({ url: resolveMediaUrl(gif.relativePath), mediaId: gif.mediaId });
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="flex min-h-full flex-col gap-2.5 p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={upload.isPending}
            className="pressable inline-flex h-9 items-center gap-1.5 rounded-full bg-accent-soft px-3.5 text-[13.5px] font-semibold text-accent-text hover:bg-accent-soft/80 disabled:opacity-60"
          >
            <ImagePlus className="size-4" strokeWidth={1.9} aria-hidden />
            {upload.isPending ? "Adding…" : "Add GIF"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/gif,video/mp4,video/webm,video/quicktime"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) upload.mutate(file);
            }}
          />
          <span className="min-w-0 flex-1" />
          {saved.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setEditing((v) => !v);
                setArmed(null);
              }}
              aria-pressed={editing}
              className="pressable h-9 rounded-full px-3 text-[13.5px] font-semibold text-fg-2 hover:bg-sunken hover:text-fg"
            >
              {editing ? "Done" : "Edit"}
            </button>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="px-1 text-[13px] text-danger">
            {error}
          </p>
        ) : null}

        {savedQuery.isPending ? (
          <div className="grid grid-cols-3 gap-1.5" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="aspect-square rounded-[var(--radius-sm)]" />
            ))}
          </div>
        ) : savedQuery.isError ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <p className="text-[13.5px] leading-relaxed text-danger">Your GIFs didn&apos;t load. Check your connection and try again.</p>
            <button type="button" onClick={() => savedQuery.refetch()} className="pressable rounded-full px-3 py-1.5 text-[13.5px] font-semibold text-accent-text hover:bg-sunken">
              Try again
            </button>
          </div>
        ) : saved.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <div className="text-[15px] font-semibold text-fg">No saved GIFs yet</div>
            <p className="text-[13.5px] leading-relaxed text-muted">
              Save a GIF from any chat (right-click or long-press it), or add one from your device. Short videos become looping GIFs.
            </p>
          </div>
        ) : (
          <div ref={containerRef} onKeyDown={onKeyDown} className="grid grid-cols-3 gap-1.5" aria-label="Saved GIFs" role="group">
            {saved.map((gif, i) => (
              <SavedGifTile
                key={gif.id}
                gif={gif}
                removing={editing || armed === gif.id}
                gridProps={itemProps(i)}
                onSend={() => send(gif)}
                onArm={() => setArmed(gif.id)}
                onDisarm={() => setArmed(null)}
                onRemove={() => remove.mutate(gif.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SavedGifTile({
  gif,
  removing,
  gridProps,
  onSend,
  onArm,
  onDisarm,
  onRemove,
}: {
  gif: SavedGif;
  removing: boolean;
  gridProps: ReturnType<ReturnType<typeof useRovingGrid>["itemProps"]>;
  onSend: () => void;
  onArm: () => void;
  onDisarm: () => void;
  onRemove: () => void;
}) {
  const longPress = useLongPress(() => onArm());
  const label = gif.title ? `Send GIF: ${gif.title}` : "Send GIF";
  return (
    <div className="relative aspect-square">
      <button
        type="button"
        aria-label={label}
        title={gif.title || undefined}
        {...gridProps}
        onClick={() => {
          if (longPress.firedRef.current) return;
          // Tapping a tile that's showing "Remove" just cancels that.
          if (removing) onDisarm();
          else onSend();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onArm();
        }}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            onRemove();
          }
        }}
        {...longPress.handlers}
        style={{ WebkitTouchCallout: "none" }}
        className={cn(
          "pressable block size-full overflow-hidden rounded-[var(--radius-sm)] bg-sunken",
          removing && "opacity-60",
        )}
      >
        <GifImage src={resolveMediaUrl(gif.relativePath)} alt="" className="size-full" mediaClassName="object-cover" />
      </button>
      {removing ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove from saved GIFs"
          className="pressable absolute inset-x-1.5 bottom-1.5 flex h-8 items-center justify-center gap-1 rounded-full bg-raised/95 text-[12.5px] font-semibold text-danger shadow-md hover:bg-raised"
        >
          <Trash2 className="size-3.5" strokeWidth={2} aria-hidden />
          Remove
        </button>
      ) : null}
    </div>
  );
}

function GiphyView({ trending, onPick }: { trending: GiphyHit[]; onPick: (gif: GifPick) => void }) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query.trim(), 350);
  const [sendError, setSendError] = useState<string | null>(null);
  const searching = debounced.length >= 2;
  const searchQuery = useQuery({
    queryKey: ["gifs", "giphy", "search", debounced],
    queryFn: () => searchGiphy(debounced, 24),
    enabled: searching,
  });
  const hits = searching ? (searchQuery.data ?? []) : trending;
  const { containerRef, onKeyDown, itemProps } = useRovingGrid();
  const mirror = useMutation({
    mutationFn: (hit: GiphyHit) => mirrorGiphyGif(hit.id),
    onSuccess: (res) => onPick({ url: res.url }),
    onError: () => setSendError("That GIF didn't send. Try another one."),
  });

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="flex min-h-full flex-col gap-2.5 p-3">
        <label className="flex h-10 shrink-0 items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-sunken px-3 text-muted transition-colors focus-within:border-accent focus-within:bg-raised hover:border-line-strong">
          <Search className="size-[17px] shrink-0" strokeWidth={1.8} aria-hidden />
          <span className="sr-only">Search GIFs</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search GIFs"
            autoComplete="off"
            style={{ outline: "none" }}
            className="h-full w-full bg-transparent text-[14px] text-fg outline-none placeholder:text-muted focus-visible:outline-none"
          />
        </label>
        {sendError ? (
          <p role="alert" className="px-1 text-[13px] text-danger">
            {sendError}
          </p>
        ) : null}
        {searching && searchQuery.isPending ? (
          <div className="grid grid-cols-3 gap-1.5" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="aspect-square rounded-[var(--radius-sm)]" />
            ))}
          </div>
        ) : searching && searchQuery.isError ? (
          <p className="px-1 py-2 text-[13.5px] text-danger">Search didn&apos;t load. Check your connection and try again.</p>
        ) : hits.length === 0 ? (
          <p className="px-1 py-2 text-[13.5px] text-muted">No GIFs match &ldquo;{debounced}&rdquo;. Try a different word.</p>
        ) : (
          <div ref={containerRef} onKeyDown={onKeyDown} className="grid grid-cols-3 gap-1.5" role="group" aria-label={searching ? "GIF results" : "Trending GIFs"}>
            {hits.map((hit, i) => (
              <button
                key={hit.id}
                type="button"
                aria-label={hit.title ? `Send GIF: ${hit.title}` : "Send GIF"}
                disabled={mirror.isPending}
                onClick={() => {
                  setSendError(null);
                  mirror.mutate(hit);
                }}
                {...itemProps(i)}
                className="pressable aspect-square overflow-hidden rounded-[var(--radius-sm)] bg-sunken disabled:opacity-60"
              >
                <GifImage src={hit.previewUrl} alt="" className="size-full" mediaClassName="object-cover" />
              </button>
            ))}
          </div>
        )}
        <p className="mt-auto pt-1 text-center text-[11.5px] font-semibold tracking-wide text-muted">Powered by GIPHY</p>
      </div>
    </div>
  );
}
