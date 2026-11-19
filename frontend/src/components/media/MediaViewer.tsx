"use client";

/* eslint-disable @next/next/no-img-element -- remote, backend-hosted media */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, Download, ImageOff, MessageSquareText, MoreHorizontal, Pause, Play, X, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/cn";
import { useBackToClose } from "@/hooks/use-back-to-close";
import { usePerformance } from "@/contexts/performance-context";
import { senderName as nameOf, type ChatMessage } from "@/lib/api/types";
import { videoPosterUrl } from "@/lib/media-url";
import { attachmentIsVideo } from "@/lib/album-layout";
import { bubbleImageSources, mediaFileName, resolveAttachmentUrl, viewerImageSources } from "@/lib/media-src";
import { Spinner } from "@/components/ui/Spinner";
import type { PlaybackTrack } from "@/lib/playback";
import { VideoPlayer } from "./VideoPlayer";
import { DOUBLE_TAP_MS, PAGE_MS, isTapDuration, settleOffset, slideOffsetPct, swipeStep, trackDragOffset } from "./media-gesture";

const FOCUSABLE = 'button:not([disabled]),[href],input,[tabindex]:not([tabindex="-1"])';
const MAX_SCALE = 5;

export interface MediaViewerItem {
  /** `${messageId}:${attachmentIndex}` */
  key: string;
  messageId: string;
  attachmentIndex: number;
  kind: "image" | "video" | "gif";
  url: string;
  width?: number | null;
  height?: number | null;
  blurhash?: string | null;
  senderName: string;
  createdAt: string;
  durationSec?: number | null;
  /** The message's caption, shown under the controls; null when there is none. */
  caption?: string | null;
}

type MessageLike = Pick<ChatMessage, "_id" | "type" | "attachments" | "attachmentMeta" | "createdAt" | "durationSec" | "content"> & {
  senderId?: ChatMessage["senderId"];
  senderLabel?: string;
};

/** The viewable photos/videos/GIFs of some messages, oldest first. */
export function mediaItemsFrom(messages: readonly MessageLike[], currentUserId?: string): MediaViewerItem[] {
  const items: MediaViewerItem[] = [];
  for (const m of messages) {
    if (m.type !== "image" && m.type !== "video" && m.type !== "gif") continue;
    const sender =
      m.senderLabel ??
      (m.senderId == null
        ? "Someone"
        : (typeof m.senderId === "string" ? m.senderId : m.senderId._id) === currentUserId
          ? "You"
          : nameOf(m.senderId));
    (m.attachments ?? []).forEach((url, i) => {
      const meta = m.attachmentMeta?.[url];
      items.push({
        key: `${m._id}:${i}`,
        messageId: m._id,
        attachmentIndex: i,
        // Albums can mix photos and videos: each attachment has its own kind.
        kind: m.type === "gif" ? "gif" : attachmentIsVideo(m.type, url, meta) ? "video" : "image",
        url,
        width: meta?.width,
        height: meta?.height,
        blurhash: meta?.blurhash,
        senderName: sender,
        createdAt: m.createdAt,
        durationSec: meta?.durationSec ?? m.durationSec,
        caption: m.content?.trim() || null,
      });
    });
  }
  return items;
}

interface MediaViewerApi {
  /** Opens the viewer at one attachment; `fallback` is used when the provider's list
   *  doesn't have it (e.g. a message still sending). */
  open: (messageId: string, attachmentIndex: number, fallback: MediaViewerItem[]) => void;
  /** The chat these messages belong to (for the app-wide player). */
  channelId: () => string | undefined;
  /** The next voice message after `id` in this chat, for auto-advance. */
  nextVoice: (id: string) => PlaybackTrack | null;
}

const MediaViewerContext = createContext<MediaViewerApi | null>(null);

export function useMediaViewer(): MediaViewerApi | null {
  return useContext(MediaViewerContext);
}

/** Lets every bubble below open the shared viewer over the chat's loaded media. The API
 *  object never changes, so memoised bubbles don't re-render when messages load. */
export function MediaViewerProvider({ messages, currentUserId, children }: { messages: readonly ChatMessage[] | undefined; currentUserId?: string; children: React.ReactNode }) {
  const messagesRef = useRef(messages);
  useLayoutEffect(() => {
    messagesRef.current = messages;
  });
  const [state, setState] = useState<{ items: MediaViewerItem[]; index: number } | null>(null);

  const open = useCallback<MediaViewerApi["open"]>(
    (messageId, attachmentIndex, fallback) => {
      const items = mediaItemsFrom((messagesRef.current ?? []).filter((m) => !m.deletedFor?.includes(currentUserId ?? "")), currentUserId);
      const index = items.findIndex((it) => it.messageId === messageId && it.attachmentIndex === attachmentIndex);
      if (index >= 0) setState({ items, index });
      else {
        const fi = fallback.findIndex((it) => it.attachmentIndex === attachmentIndex);
        if (fallback.length) setState({ items: fallback, index: Math.max(0, fi) });
      }
    },
    [currentUserId],
  );
  const channelId = useCallback(() => messagesRef.current?.[0]?.channelId, []);
  const nextVoice = useCallback(
    (id: string): PlaybackTrack | null => {
      const list = messagesRef.current ?? [];
      const i = list.findIndex((m) => m._id === id);
      if (i < 0) return null;
      const next = list.slice(i + 1).find((m) => m.type === "voice" && m.attachments?.[0] && !m.deletedFor?.includes(currentUserId ?? ""));
      if (!next) return null;
      const sid = typeof next.senderId === "string" ? next.senderId : next.senderId?._id;
      return {
        id: next._id,
        kind: "voice",
        src: resolveAttachmentUrl(next.attachments[0]),
        durationSec: next.durationSec,
        senderName: sid === currentUserId ? "You" : nameOf(next.senderId),
        createdAt: next.createdAt,
        channelId: next.channelId,
      };
    },
    [currentUserId],
  );
  const api = useMemo(() => ({ open, channelId, nextVoice }), [open, channelId, nextVoice]);

  return (
    <MediaViewerContext.Provider value={api}>
      {children}
      {state ? <MediaViewer items={state.items} startIndex={state.index} onClose={() => setState(null)} /> : null}
    </MediaViewerContext.Provider>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function downloadMedia(url: string) {
  const href = resolveAttachmentUrl(url);
  try {
    const res = await fetch(href, { mode: "cors" });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = mediaFileName(url);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  } catch {
    window.open(href, "_blank", "noopener");
  }
}

interface Transform {
  scale: number;
  x: number;
  y: number;
}
const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

export interface MediaViewerProps {
  items: MediaViewerItem[];
  startIndex?: number;
  onClose: () => void;
  /** How many there are in all, when `items` are only the newest ones loaded so far (a
   *  chat's shared media): the counter reads "3 of 120". */
  total?: number;
  /** Called when paging gets near the oldest loaded item — load older ones and pass them in
   *  (prepended); the viewer stays on the item it shows. */
  onNearStart?: () => void;
  /** Adds "Show in chat" to the top bar. */
  onShowInChat?: (item: MediaViewerItem) => void;
}

/** Full-screen photo/video viewer over the chat (Telegram-style): ←/→ or swipe between the
 *  chat's loaded media, pinch / wheel / double-tap to zoom, drag to pan, swipe down or Esc
 *  to close. Focus is trapped and returns to the bubble that opened it. Only now is the
 *  large version of a photo loaded; the bubble's small one shows meanwhile. */
const VIEWER_SPEEDS = [0.5, 1, 1.5, 2] as const;

/** A message's caption in the viewer: a scrollable block with a capped height, as in Telegram, so a
 *  long caption never pushes the controls or the photo off screen. */
function ViewerCaption({ text }: { text: string }) {
  return (
    <div
      dir="auto"
      className="pointer-events-auto mt-2 max-h-[22vh] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-[15px] leading-snug text-white/90 [scrollbar-width:none] [text-shadow:0_1px_2px_rgb(0_0_0/0.5)]"
    >
      {text}
    </div>
  );
}

export function MediaViewer({ items, startIndex = 0, onClose, total, onNearStart, onShowInChat }: MediaViewerProps) {
  const { reduceMotion } = usePerformance();
  const count = items.length;
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(count - 1, 0)));
  // Older items arrive prepended: stay on the one being shown.
  const [prevItems, setPrevItems] = useState(items);
  if (prevItems !== items) {
    setPrevItems(items);
    const shownKey = prevItems[Math.min(index, prevItems.length - 1)]?.key;
    const moved = shownKey ? items.findIndex((it) => it.key === shownKey) : -1;
    if (moved >= 0 && moved !== index) setIndex(moved);
    else if (moved < 0 && index > items.length - 1) setIndex(Math.max(0, items.length - 1));
  }
  const onNearStartRef = useRef(onNearStart);
  useLayoutEffect(() => {
    onNearStartRef.current = onNearStart;
  });
  useEffect(() => {
    if (index <= 2) onNearStartRef.current?.();
  }, [index, count]);
  const [t, setT] = useState<Transform>(IDENTITY);
  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [animating, setAnimating] = useState(false);
  // A horizontal swipe is under way: the shown clip pauses so it doesn't play while it leaves.
  const [swiping, setSwiping] = useState(false);
  // The page turn in flight (-1 / +1), committed to `index` once its animation has finished.
  const settleRef = useRef<-1 | 1 | null>(null);
  const settleTimer = useRef<number | null>(null);
  const [rtl] = useState(() => typeof document !== "undefined" && getComputedStyle(document.body).direction === "rtl");
  const [fullLoaded, setFullLoaded] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [pausedKey, setPausedKey] = useState<string | null>(null);
  const [originalWanted, setOriginalWanted] = useState<Record<string, boolean>>({});
  const [downloading, setDownloading] = useState(false);
  // Top bar's ⋯ menu: download, and the playback speed for videos (kept while paging).
  const [menuOpen, setMenuOpen] = useState(false);
  // The HUD: the top bar and the caption. A tap on a photo toggles it; a video reports its own.
  const [hud, setHud] = useState(true);
  const [rate, setRate] = useState(1);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [returnFocusTo] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  // The phone's back button/gesture closes the viewer, not the chat.
  useBackToClose(() => onCloseRef.current());

  const item = items[Math.min(index, count - 1)];
  const zoomed = t.scale > 1.01;
  const itemKey = item?.key;
  const deepZoom = t.scale > 1.6;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- latches "load the original" once zoomed in deep enough
    if (deepZoom && itemKey) setOriginalWanted((w) => (w[itemKey] ? w : { ...w, [itemKey]: true }));
  }, [deepZoom, itemKey]);

  const go = useCallback(
    (dir: number) => {
      setIndex((i) => Math.min(Math.max(i + dir, 0), count - 1));
      setT(IDENTITY);
    },
    [count],
  );

  /** Ends a page turn: the index moves to the neighbour that was sliding in, and the track
   *  snaps back to rest in the same render, so nothing jumps. */
  const finishSettle = useCallback(() => {
    const step = settleRef.current;
    if (step === null) return;
    settleRef.current = null;
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = null;
    setIndex((i) => Math.min(Math.max(i + step, 0), count - 1));
    setT(IDENTITY);
    setDragX(0);
    setAnimating(false);
    setSwiping(false);
  }, [count]);
  const finishRef = useRef(finishSettle);
  useLayoutEffect(() => {
    finishRef.current = finishSettle;
  });
  useEffect(() => () => {
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
  }, []);

  /** Animates the track to the neighbour `step` away (then commits it), or springs back to rest
   *  when `step` is 0. Reduced motion switches at once. */
  function settle(step: -1 | 0 | 1) {
    if (step === 0) {
      setAnimating(true);
      setDragX(0);
      setSwiping(false);
      return;
    }
    if (reduceMotion) {
      go(step);
      setDragX(0);
      setSwiping(false);
      return;
    }
    const width = stageRef.current?.clientWidth ?? 400;
    settleRef.current = step;
    setAnimating(true);
    setDragX(settleOffset(step, width, rtl));
    // Fallback in case no transitionend arrives (e.g. the track was already in place).
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => finishRef.current(), PAGE_MS + 60);
  }

  // Focus in, scroll lock, focus back out.
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  // Preload the neighbours' large photos so paging feels instant.
  useEffect(() => {
    for (const n of [items[index - 1], items[index + 1]]) {
      if (n?.kind === "image") {
        const img = new Image();
        img.decoding = "async";
        img.src = viewerImageSources(n.url).src;
      }
    }
  }, [index, items]);

  const clampT = useCallback((next: Transform): Transform => {
    const stage = stageRef.current;
    if (!stage || next.scale <= 1) return IDENTITY;
    const scale = Math.min(MAX_SCALE, next.scale);
    const maxX = ((scale - 1) * stage.clientWidth) / 2;
    const maxY = ((scale - 1) * stage.clientHeight) / 2;
    return { scale, x: Math.min(maxX, Math.max(-maxX, next.x)), y: Math.min(maxY, Math.max(-maxY, next.y)) };
  }, []);

  /** Zoom to `scale` keeping the stage point (clientX, clientY) under the finger/cursor. */
  const zoomAt = useCallback(
    (scale: number, clientX?: number, clientY?: number, from?: Transform) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const px = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
      const py = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);
      setT((cur) => {
        const base = from ?? cur;
        const s = Math.min(MAX_SCALE, Math.max(1, scale));
        const k = s / base.scale;
        return clampT({ scale: s, x: px - (px - base.x) * k, y: py - (py - base.y) * k });
      });
    },
    [clampT],
  );

  // Keys on window capture, so nothing underneath reacts: Esc, ←/→, Home/End, +/−, Tab trap.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const root = rootRef.current;
      if (!root) return;
      const inRange = e.target instanceof HTMLInputElement && e.target.type === "range";
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (document.fullscreenElement) return; // the browser leaves full screen first
        onCloseRef.current();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !inRange) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const rtl = getComputedStyle(root).direction === "rtl";
        go((e.key === "ArrowRight") !== rtl ? 1 : -1);
      } else if ((e.key === "Home" || e.key === "End") && !inRange) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setIndex(e.key === "Home" ? 0 : count - 1);
        setT(IDENTITY);
      } else if ((e.key === "+" || e.key === "=" || e.key === "-") && item?.kind === "image") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setT((cur) => clampT({ ...cur, scale: e.key === "-" ? cur.scale / 1.5 : cur.scale * 1.5 }));
      } else if (e.key === "Tab") {
        e.stopImmediatePropagation();
        const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
        if (nodes.length === 0) return e.preventDefault();
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!root.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [count, go, item?.kind, clampT]);

  // Wheel / trackpad zoom (needs a non-passive listener to stop the page zooming).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || item?.kind !== "image") return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      setT((cur) => {
        const s = Math.min(MAX_SCALE, Math.max(1, cur.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025))));
        const rect = stage!.getBoundingClientRect();
        const px = e.clientX - (rect.left + rect.width / 2);
        const py = e.clientY - (rect.top + rect.height / 2);
        const k = s / cur.scale;
        return clampT({ scale: s, x: px - (px - cur.x) * k, y: py - (py - cur.y) * k });
      });
    }
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [item?.kind, clampT]);

  // Pointer gestures: one finger pages (x), closes (down) or pans (when zoomed); two pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    startX: number;
    startY: number;
    axis: "x" | "y" | "pan" | null;
    base: Transform;
    pinch?: { dist: number; base: Transform };
    moved: boolean;
    /** Press start (event time), to tell a tap from a long press. */
    t0: number;
    /** Smoothed horizontal speed (px/ms) and the last sample, for flicks. */
    vx: number;
    lastX: number;
    lastT: number;
  } | null>(null);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  // A photo's single tap waits out the double-tap window (a second tap zooms instead) before it
  // shows or hides the HUD.
  const tapTimer = useRef<number | null>(null);
  const cancelTap = useCallback(() => {
    if (tapTimer.current) window.clearTimeout(tapTimer.current);
    tapTimer.current = null;
  }, []);
  useEffect(() => () => cancelTap(), [cancelTap]);

  function onPointerDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest("button,input,[data-no-gesture]")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Grabbing mid page turn: land on the new page first, so the track doesn't jump back.
    if (settleRef.current !== null) finishRef.current();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setAnimating(false);
    cancelTap();
    if (pointers.current.size === 2 && item?.kind === "image") {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { startX: e.clientX, startY: e.clientY, axis: "pan", base: t, pinch: { dist: Math.hypot(a.x - b.x, a.y - b.y), base: t }, moved: true, t0: e.timeStamp, vx: 0, lastX: e.clientX, lastT: e.timeStamp };
      setDragX(0);
      setDragY(0);
    } else if (pointers.current.size === 1) {
      gesture.current = { startX: e.clientX, startY: e.clientY, axis: zoomed ? "pan" : null, base: t, moved: false, t0: e.timeStamp, vx: 0, lastX: e.clientX, lastT: e.timeStamp };
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((g.pinch.base.scale * dist) / Math.max(1, g.pinch.dist), (a.x + b.x) / 2, (a.y + b.y) / 2, g.pinch.base);
      return;
    }
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) < 8) return;
    g.moved = true;
    if (g.axis === "pan") {
      setT(clampT({ scale: g.base.scale, x: g.base.x + dx, y: g.base.y + dy }));
      return;
    }
    if (!g.axis) g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (g.axis === "x") {
      const dt = e.timeStamp - g.lastT;
      if (dt > 0) g.vx = 0.6 * g.vx + 0.4 * ((e.clientX - g.lastX) / dt);
      g.lastX = e.clientX;
      g.lastT = e.timeStamp;
      setSwiping(true);
      setDragX(trackDragOffset(dx, index, count, rtl));
    } else setDragY(Math.max(0, dy));
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.pinch) {
      if (pointers.current.size === 0) gesture.current = null;
      else {
        const [p] = [...pointers.current.values()];
        gesture.current = { startX: p.x, startY: p.y, axis: "pan", base: t, moved: true, t0: e.timeStamp, vx: 0, lastX: p.x, lastT: e.timeStamp };
      }
      return;
    }
    gesture.current = null;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    setAnimating(true);
    if (!g.moved) {
      // GIF: a tap pauses / resumes it.
      if (item?.kind === "gif") {
        setPausedKey((k) => (k === item.key ? null : item.key));
        return;
      }
      // Videos handle their own taps (a tap shows or hides their HUD).
      if (item?.kind !== "image") return;
      // Photo: a second tap soon after zooms in (or back out) and cancels the pending HUD toggle.
      const now = e.timeStamp;
      const prev = lastTap.current;
      if (prev && now - prev.time < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 30) {
        lastTap.current = null;
        cancelTap();
        if (zoomed) setT(IDENTITY);
        else zoomAt(2.5, e.clientX, e.clientY);
        return;
      }
      lastTap.current = { time: now, x: e.clientX, y: e.clientY };
      // A single tap shows or hides the HUD (not for a long press). Edges don't page.
      if (isTapDuration(now - g.t0)) {
        tapTimer.current = window.setTimeout(() => {
          tapTimer.current = null;
          setHud((h) => !h);
        }, DOUBLE_TAP_MS);
      }
      return;
    }
    if (g.axis === "x") {
      const width = stageRef.current?.clientWidth ?? 400;
      const step = e.type === "pointercancel" ? 0 : swipeStep({ dx, vx: g.vx, width, rtl, canPrev: index > 0, canNext: index < count - 1 });
      settle(step);
    } else if (g.axis === "y") {
      if (dy > 110) onCloseRef.current();
      else setDragY(0);
    }
  }

  if (typeof document === "undefined" || !item) return null;

  const fade = dragY ? Math.max(0.3, 1 - dragY / 400) : 1;
  const prevItem = index > 0 ? items[index - 1] : undefined;
  const nextItem = index < count - 1 ? items[index + 1] : undefined;
  const chromeBtn =
    "pressable flex size-11 shrink-0 items-center justify-center rounded-full text-white hover:bg-white/15 [&_svg]:size-6 disabled:opacity-40 disabled:hover:bg-transparent";
  // Top bar buttons: round, on a soft dark disc so they read over any photo.
  const topBtn =
    "pointer-events-auto pressable flex size-10 shrink-0 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-md hover:bg-black/50 disabled:opacity-40 [&_svg]:size-5 focus-visible:outline-2 focus-visible:outline-white";
  const motion = animating && !reduceMotion ? "transform 220ms var(--ease-out)" : "none";
  const full = viewerImageSources(item.url);
  const small = bubbleImageSources(item.url);
  const fullReady = !!fullLoaded[item.key];
  const kindLabel = item.kind === "video" ? "Video" : item.kind === "gif" ? "GIF" : "Photo";

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${kindLabel} from ${item.senderName}`}
      className="fade-in fixed inset-0 z-[96] flex flex-col text-white"
      style={{ backgroundColor: `rgb(0 0 0 / ${fade})` }}
      data-media-viewer=""
    >
      {/* Top bar: floats over the media like the video's HUD. Its gradient lets taps through to the
          media; only the buttons take taps. */}
      <div
        className={cn("safe-top pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/70 via-black/30 to-transparent pb-10 transition-opacity duration-300 ease-out", !hud && "invisible opacity-0")}
        style={hud ? { opacity: fade } : undefined}
      >
        <div className="flex items-center gap-2 px-3 pt-2 sm:px-4">
          <button ref={closeRef} type="button" onClick={() => onCloseRef.current()} aria-label="Close" title="Close (Esc)" className={topBtn}>
            <X strokeWidth={2} />
          </button>
          <div className="pointer-events-none min-w-0 flex-1 px-1">
            <div dir="auto" className="truncate text-[15px] font-semibold leading-tight [text-shadow:0_1px_3px_rgb(0_0_0/0.5)]">
              {item.senderName}
            </div>
            <div className="tabular truncate text-[13px] text-white/80 [text-shadow:0_1px_3px_rgb(0_0_0/0.5)]">
              <time dateTime={item.createdAt}>{formatWhen(item.createdAt)}</time>
              {count > 1 || (total ?? 0) > 1 ? (
                <span aria-live="polite" aria-atomic>
                  {" · "}
                  {(total && total >= count ? total - (count - 1 - index) : index + 1).toLocaleString()} of {(total && total >= count ? total : count).toLocaleString()}
                </span>
              ) : null}
            </div>
          </div>
          {item.kind === "image" ? (
            <button
              type="button"
              onClick={() => {
                setAnimating(true);
                if (zoomed) setT(IDENTITY);
                else zoomAt(2.5);
              }}
              aria-label={zoomed ? "Zoom out" : "Zoom in"}
              title={zoomed ? "Zoom out (−)" : "Zoom in (+)"}
              className={topBtn}
            >
              {zoomed ? <ZoomOut strokeWidth={2} /> : <ZoomIn strokeWidth={2} />}
            </button>
          ) : null}
          {onShowInChat ? (
            <button type="button" onClick={() => onShowInChat(item)} aria-label="Show in chat" title="Show in chat" className={topBtn}>
              <MessageSquareText strokeWidth={2} />
            </button>
          ) : null}
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="More"
              className={topBtn}
            >
              <MoreHorizontal strokeWidth={2} />
            </button>
            {menuOpen && hud ? (
              <>
                {/* A transparent layer behind the menu: a tap anywhere else closes it. */}
                <div aria-hidden className="pointer-events-auto fixed inset-0 z-[19]" onClick={() => setMenuOpen(false)} />
                <div role="menu" aria-label="More options" className="pointer-events-auto absolute end-0 top-full z-20 mt-2 w-56 rounded-2xl bg-black/80 p-1.5 text-white shadow-2xl backdrop-blur-xl">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={downloading}
                    onClick={() => {
                      setMenuOpen(false);
                      setDownloading(true);
                      void downloadMedia(item.url).finally(() => setDownloading(false));
                    }}
                    className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-[15px] hover:bg-white/10 disabled:opacity-40"
                  >
                    <Download className="size-5" strokeWidth={2} aria-hidden />
                    {`Download ${kindLabel.toLowerCase()}`}
                  </button>
                  {item.kind === "video" ? (
                    <>
                      <div role="separator" className="my-1.5 h-px bg-white/15" />
                      <div className="px-3 pb-1 pt-1 text-[12px] font-medium uppercase tracking-wide text-white/55">Playback speed</div>
                      {VIEWER_SPEEDS.map((s) => (
                        <button
                          key={s}
                          type="button"
                          role="menuitemradio"
                          aria-checked={rate === s}
                          onClick={() => {
                            setRate(s);
                            setMenuOpen(false);
                          }}
                          className="flex h-11 w-full items-center justify-between rounded-xl px-3 text-[15px] tabular hover:bg-white/10"
                        >
                          {s === 1 ? "Normal" : `${s}×`}
                          {rate === s ? <Check className="size-5" strokeWidth={2.2} aria-hidden /> : null}
                        </button>
                      ))}
                    </>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Photos and GIFs: the caption sits at the bottom, over a soft gradient (videos show it under their controls). */}
      {item.kind !== "video" && item.caption ? (
        <div
          className={cn("pointer-events-none absolute inset-x-0 bottom-0 z-[5] bg-gradient-to-t from-black/75 via-black/35 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-14 transition-opacity duration-300 ease-out sm:px-5", !hud && "invisible opacity-0")}
          style={hud ? { opacity: fade } : undefined}
        >
          <ViewerCaption text={item.caption} />
        </div>
      ) : null}

      {/* Stage */}
      <div
        ref={stageRef}
        className={cn(
          "relative min-h-0 flex-1 touch-none select-none overflow-hidden [-webkit-touch-callout:none]",
          zoomed ? "cursor-grab active:cursor-grabbing" : item.kind === "image" && "cursor-zoom-in",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // No browser save/share menu on a press-and-hold (the hold gestures still work).
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* The track holds the shown page with its neighbours on either side: a swipe moves all
            of them with the finger, and a page turn slides the track to a neighbour. */}
        <div
          className="absolute inset-0"
          style={{
            transform: `translate3d(${dragX}px, ${dragY}px, 0) scale(${dragY ? 1 - Math.min(dragY, 300) / 1500 : 1})`,
            transition: animating && !reduceMotion ? `transform ${PAGE_MS}ms var(--ease-out)` : "none",
          }}
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget) finishRef.current();
          }}
        >
          {prevItem ? <SlidePreview item={prevItem} offsetPct={slideOffsetPct(-1, rtl)} /> : null}
          {nextItem ? <SlidePreview item={nextItem} offsetPct={slideOffsetPct(1, rtl)} /> : null}
          <div key={item.key} className="absolute inset-0">
          {item.kind === "video" ? (
            <div className="absolute inset-0 flex items-center justify-center p-0 sm:px-16 sm:pb-4">
              <VideoPlayer
                key={item.key}
                src={resolveAttachmentUrl(item.url)}
                poster={videoPosterUrl(resolveAttachmentUrl(item.url))}
                durationSec={item.durationSec}
                variant="full"
                autoPlay
                label={`Video from ${item.senderName}`}
                pauseWhen={swiping}
                rate={rate}
                footer={item.caption ? <ViewerCaption text={item.caption} /> : null}
                onHudChange={setHud}
                className="size-full max-h-full sm:rounded-[var(--radius-md)]"
              />
            </div>
          ) : item.kind === "gif" ? (
            <ViewerGif key={item.key} url={item.url} paused={pausedKey === item.key} label={`GIF from ${item.senderName}`} onToggle={() => setPausedKey((k) => (k === item.key ? null : item.key))} />
          ) : (
            <div
              className="absolute inset-0"
              style={{ transform: `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`, transformOrigin: "center", transition: motion }}
            >
              {/* The bubble's small copy (already cached) right away; the large one fades in over it. */}
              {!fullReady ? (
                <img src={small.src} srcSet={small.srcSet} sizes={small.sizes} alt="" aria-hidden draggable={false} onContextMenu={(e) => e.preventDefault()} className="absolute inset-0 size-full object-contain" />
              ) : null}
              <img
                key={item.key}
                src={full.src}
                alt={`${kindLabel} from ${item.senderName}, ${formatWhen(item.createdAt)}`}
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                decoding="async"
                onLoad={() => setFullLoaded((s) => ({ ...s, [item.key]: true }))}
                onError={(e) => {
                  if (full.fallback && e.currentTarget.src !== full.fallback) e.currentTarget.src = full.fallback;
                  else setFailed((f) => ({ ...f, [item.key]: true }));
                }}
                className={cn("absolute inset-0 size-full object-contain transition-opacity duration-200", fullReady ? "opacity-100" : "opacity-0")}
              />
              {/* Zoomed in past the large copy's detail: bring in the original (only now). */}
              {originalWanted[item.key] && full.fallback ? (
                <img
                  src={full.fallback}
                  alt=""
                  aria-hidden
                  draggable={false}
                  decoding="async"
                  onLoad={(e) => (e.currentTarget.style.opacity = "1")}
                  style={{ opacity: 0 }}
                  className="absolute inset-0 size-full object-contain transition-opacity duration-200"
                />
              ) : null}
              {failed[item.key] ? (
                <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-white/85">
                  <ImageOff className="size-8" strokeWidth={1.6} aria-hidden />
                  <span className="text-[15px] font-semibold">Couldn&apos;t load this {kindLabel.toLowerCase()}</span>
                </div>
              ) : !fullReady ? (
                <span className="pointer-events-none absolute bottom-4 end-4">
                  <Spinner className="size-5 text-white/80" label="Loading full size" />
                </span>
              ) : null}
            </div>
          )}
          </div>
        </div>

        {count > 1 ? (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={index === 0}
              aria-label="Previous"
              title="Previous (←)"
              className={cn(chromeBtn, "absolute start-3 top-1/2 z-[3] hidden -translate-y-1/2 bg-black/40 [@media(hover:hover)]:flex")}
            >
              <ChevronLeft className="rtl:rotate-180" strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={index === count - 1}
              aria-label="Next"
              title="Next (→)"
              className={cn(chromeBtn, "absolute end-3 top-1/2 z-[3] hidden -translate-y-1/2 bg-black/40 [@media(hover:hover)]:flex")}
            >
              <ChevronRight className="rtl:rotate-180" strokeWidth={2} />
            </button>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** A neighbouring page while the track is moving: its still only. It never mounts a player, so
 *  a neighbouring video doesn't play under the scene; the real page takes over once it's the one shown. */
function SlidePreview({ item, offsetPct }: { item: MediaViewerItem; offsetPct: number }) {
  const src = resolveAttachmentUrl(item.url);
  let still: string | undefined;
  if (item.kind === "video") still = videoPosterUrl(src);
  else if (item.kind === "gif") still = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src) ? undefined : src;
  else still = bubbleImageSources(item.url).src;
  return (
    <div className="absolute inset-0" style={{ transform: `translate3d(${offsetPct}%, 0, 0)` }} aria-hidden>
      {still ? <img src={still} alt="" draggable={false} className="absolute inset-0 size-full object-contain" /> : null}
    </div>
  );
}

/** A GIF in the viewer: large, looping, muted, no timer or scrubber — like a video without
 *  controls. A tap (or the button, for keyboards) pauses it; paused, a GIF image shows its
 *  current frame frozen on a canvas. */
function ViewerGif({ url, paused, label, onToggle }: { url: string; paused: boolean; label: string; onToggle: () => void }) {
  const src = resolveAttachmentUrl(url);
  const isVideo = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      if (paused) v.pause();
      else void v.play().catch(() => undefined);
      return;
    }
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (paused && img && canvas && img.naturalWidth) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
    }
  }, [paused]);

  const media = "absolute inset-0 size-full object-contain";
  return (
    <div className="absolute inset-0" data-gif-viewer="">
      {!loaded ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-6 text-white/80" label="Loading GIF" />
        </span>
      ) : null}
      {isVideo ? (
        <video ref={videoRef} src={src} autoPlay loop muted playsInline aria-label={label} onLoadedData={() => setLoaded(true)} className={media} />
      ) : (
        <>
          <canvas ref={canvasRef} aria-hidden className={cn(media, !paused && "hidden")} />
          <img ref={imgRef} src={src} alt={label} draggable={false} decoding="async" onLoad={() => setLoaded(true)} className={cn(media, paused && "invisible")} />
        </>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-label={paused ? "Play GIF" : "Pause GIF"}
        className={cn(
          "absolute start-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition-opacity focus-visible:opacity-100 rtl:translate-x-1/2",
          paused ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {paused ? <Play className="ms-1 size-8 fill-current" strokeWidth={0} aria-hidden /> : <Pause className="size-8 fill-current" strokeWidth={0} aria-hidden />}
      </button>
    </div>
  );
}
