"use client";
/* eslint-disable @next/next/no-img-element -- thumbnails from the media route, sized by CSS */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, FileText, Image as ImageIcon, Mic, Music, Phone, PinOff, Video } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { useBackToClose } from "@/hooks/use-back-to-close";
import { resolveAttachmentUrl, thumbImageSources } from "@/lib/media-src";
import { videoPosterUrl } from "@/lib/media-url";
import { pinPreview, type PinKind } from "@/lib/pinned-messages";
import { senderName, type ChatMessage } from "@/lib/api/types";

/** Telegram's "Pinned messages" screen: a full-screen list of every pin, newest first. Tap a
 *  row to go to that message (the screen closes); unpin one, or all (confirmed). */
export function PinnedMessagesScreen({
  pins,
  currentUserId,
  canUnpin,
  onClose,
  onJump,
  onUnpin,
}: {
  pins: ChatMessage[];
  currentUserId: string;
  canUnpin: boolean;
  onClose: () => void;
  onJump: (messageId: string) => void;
  onUnpin: (messageIds: string[]) => Promise<void>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Captured on the first render so closing puts focus back where it was.
  const [returnFocusTo] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // The phone's Back closes this screen before it leaves the page.
  useBackToClose(() => {
    onCloseRef.current();
  });

  const newestFirst = useMemo(() => [...pins].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)), [pins]);

  useEffect(() => {
    const panel = panelRef.current;
    panel?.focus({ preventScroll: true });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);

  // Esc closes it, unless a confirm is open over it (that one handles its own Esc).
  useEffect(() => {
    if (confirmAll) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmAll]);

  // Every pin unpinned (here or elsewhere): nothing left to list.
  useEffect(() => {
    if (pins.length === 0) onCloseRef.current();
  }, [pins.length]);

  async function unpin(ids: string[]) {
    setPending((prev) => new Set([...prev, ...ids]));
    try {
      await onUnpin(ids);
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }
  }

  const n = pins.length;
  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pinned-screen-title"
        tabIndex={-1}
        className="fade-in fixed inset-0 z-[70] flex flex-col bg-panel outline-none"
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-raised ps-2 pe-3 lg:ps-4">
          <IconButton aria-label="Close" onClick={onClose} className="text-fg-2">
            <ArrowLeft className="rtl:rotate-180" strokeWidth={1.9} />
          </IconButton>
          <div className="min-w-0 flex-1">
            <h2 id="pinned-screen-title" className="truncate text-[16px] font-bold leading-tight text-fg">
              Pinned messages
            </h2>
            <p className="tabular text-[12.5px] leading-tight text-muted">
              {n} pinned message{n === 1 ? "" : "s"}
            </p>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ol className="mx-auto flex w-full max-w-[640px] flex-col">
            {newestFirst.map((m, i) => (
              <PinRow
                key={m._id}
                message={m}
                index={n - i}
                currentUserId={currentUserId}
                canUnpin={canUnpin}
                busy={pending.has(m._id)}
                onJump={() => onJump(m._id)}
                onUnpin={() => void unpin([m._id])}
              />
            ))}
          </ol>
        </div>

        {canUnpin && n > 1 ? (
          <div className="mx-auto flex w-full max-w-[640px] shrink-0 border-t border-line px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
            <Button variant="danger-soft" block onClick={() => setConfirmAll(true)} loading={pending.size > 0 && pending.size >= n}>
              <PinOff className="size-[18px]" strokeWidth={1.9} aria-hidden />
              Unpin all {n} messages
            </Button>
          </div>
        ) : null}
      </div>
      {confirmAll ? (
        <ConfirmDialog
          title={`Unpin all ${n} messages?`}
          description="They stay in the chat; they just won't be pinned for anyone."
          confirmLabel="Unpin all"
          destructive
          onClose={() => setConfirmAll(false)}
          onConfirm={() => {
            setConfirmAll(false);
            void unpin(pins.map((p) => p._id));
          }}
        />
      ) : null}
    </>,
    document.body,
  );
}

function PinRow({
  message: m,
  index,
  currentUserId,
  canUnpin,
  busy,
  onJump,
  onUnpin,
}: {
  message: ChatMessage;
  index: number;
  currentUserId: string;
  canUnpin: boolean;
  busy: boolean;
  onJump: () => void;
  onUnpin: () => void;
}) {
  const sender = typeof m.senderId === "string" ? null : m.senderId;
  const senderKey = typeof m.senderId === "string" ? m.senderId : m.senderId._id;
  const mine = senderKey === currentUserId;
  const who = mine ? "You" : senderName(m.senderId);
  const preview = pinPreview(m, currentUserId);
  const thumb = pinThumb(m);
  const photo = sender?.avatarUrl?.[0];

  return (
    <li className="flex items-center gap-1 border-b border-line pe-2 last:border-b-0">
      <button
        type="button"
        onClick={onJump}
        aria-label={`Go to pinned message ${index}: ${who}, ${preview.label ?? ""} ${preview.text}`.replace(/\s+/g, " ").trim()}
        className="focus-inset flex min-h-[72px] min-w-0 flex-1 items-center gap-3 ps-4 pe-2 py-2.5 text-start hover:bg-sunken"
      >
        <Avatar colorId={senderKey} name={sender ? senderName(sender) : who} src={photo} size={44} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-fg" dir="auto">
              {who}
            </span>
            <time dateTime={m.createdAt} className="tabular shrink-0 text-[12.5px] text-muted">
              {formatPinDate(m.createdAt)}
            </time>
          </span>
          <span className="mt-0.5 flex min-w-0 items-start gap-1.5 text-[14px] leading-snug text-fg-2">
            {!thumb ? <KindIcon kind={preview.kind} /> : null}
            <span className="line-clamp-2 min-w-0 flex-1 break-words" dir="auto">
              {preview.label ? <span className="font-medium text-fg">{preview.label}</span> : null}
              {preview.label && preview.text ? " · " : null}
              {preview.text}
            </span>
          </span>
        </span>
        {thumb ? (
          <span className="size-11 shrink-0 overflow-hidden rounded-md bg-sunken" aria-hidden>
            <img
              src={thumb.src}
              alt=""
              loading="lazy"
              className="size-full object-cover"
              onError={(e) => {
                if (thumb.fallback && e.currentTarget.src !== thumb.fallback) e.currentTarget.src = thumb.fallback;
              }}
            />
          </span>
        ) : null}
      </button>
      {canUnpin ? (
        <IconButton aria-label={`Unpin message ${index}`} disabled={busy} onClick={onUnpin} className="text-muted">
          <PinOff strokeWidth={1.8} />
        </IconButton>
      ) : null}
    </li>
  );
}

/** A small picture for a photo, album photo or video (its poster frame); null otherwise. */
function pinThumb(m: ChatMessage): { src: string; fallback?: string } | null {
  const url = m.attachments?.[0];
  if (!url) return null;
  const meta = m.attachmentMeta?.[url];
  if (m.type === "video" || meta?.kind === "video") {
    const poster = meta?.posterUrl ? resolveAttachmentUrl(meta.posterUrl) : videoPosterUrl(resolveAttachmentUrl(url));
    return poster ? { src: poster } : null;
  }
  if (m.type === "image") {
    const s = thumbImageSources(url);
    return { src: s.src, fallback: s.fallback };
  }
  return null;
}

/** The small glyph that stands in for a thumbnail (media without a picture, calls). */
function KindIcon({ kind }: { kind: PinKind }) {
  const cls = "mt-0.5 size-[15px] shrink-0 text-muted";
  switch (kind) {
    case "photo":
    case "album":
    case "gif":
      return <ImageIcon className={cls} strokeWidth={1.9} aria-hidden />;
    case "video":
    case "video_note":
      return <Video className={cls} strokeWidth={1.9} aria-hidden />;
    case "file":
      return <FileText className={cls} strokeWidth={1.9} aria-hidden />;
    case "music":
      return <Music className={cls} strokeWidth={1.9} aria-hidden />;
    case "voice":
      return <Mic className={cls} strokeWidth={1.9} aria-hidden />;
    case "call":
      return <Phone className={cls} strokeWidth={1.9} aria-hidden />;
    default:
      return null;
  }
}

function formatPinDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
}
