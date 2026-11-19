"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ListOrdered, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { PinnedMessagesScreen } from "@/components/chat/PinnedMessagesScreen";
import { cn } from "@/lib/cn";
import { pinSnippet } from "@/lib/pinned-messages";
import { senderName, type ChatMessage } from "@/lib/api/types";

/** Max segments shown at once in the bar's indicator (Telegram shows a sliding window of 4). */
const VISIBLE_SEGMENTS = 4;
/** After a tap, scroll-following waits this long (the jump's own scroll, incl. loading). */
const TAP_FOLLOW_PAUSE_MS = 1500;

/**
 * Telegram's pinned-message bar. Shows one pin at a time, starting with the newest; tapping
 * jumps to it and moves the bar on to the previous (older) pin, wrapping from the oldest
 * back to the newest. A vertical segmented indicator on the left (one segment per pin, a
 * sliding window of four) shows which one. The sender's name and the pin's snippet follow.
 * With more than one pin a list button opens all of them full-screen (PinnedMessagesScreen);
 * a single pin you may unpin gets an ×.
 *
 * `pins` comes from GET …/pinned (newest first). `followId` is the pin at or above the
 * reader's scroll position (ConversationView): the bar follows it as you scroll, except
 * right after a tap, while the jump's own scroll settles — so tap-cycling isn't undone.
 */
export function PinnedBar({
  pins,
  currentUserId,
  canUnpin,
  onJump,
  onUnpin,
  followId,
}: {
  pins: ChatMessage[];
  currentUserId: string;
  canUnpin: boolean;
  onJump: (messageId: string) => void;
  onUnpin: (messageIds: string[]) => Promise<void>;
  followId?: string | null;
}) {
  // Oldest first, so the indicator reads top (oldest) → bottom (newest).
  const ordered = useMemo(() => [...pins].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)), [pins]);
  const n = ordered.length;
  const signature = ordered.map((p) => p._id).join(",");
  // Which pin the bar shows, by id (so a new pin or an unpin elsewhere doesn't shift it
  // onto a different message); falls back to the newest.
  const [shownId, setShownId] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [confirmUnpin, setConfirmUnpin] = useState(false);
  const lastSignature = useRef(signature);
  useEffect(() => {
    // A pin added since: show it (Telegram jumps the bar to a fresh pin).
    const before = new Set(lastSignature.current.split(","));
    const added = ordered.filter((p) => !before.has(p._id));
    lastSignature.current = signature;
    if (added.length) setShownId(added[added.length - 1]._id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Follow the scroll position — but not while a tap's jump is still scrolling.
  const tappedAtRef = useRef(0);
  useEffect(() => {
    if (!followId || Date.now() - tappedAtRef.current < TAP_FOLLOW_PAUSE_MS) return;
    setShownId(followId);
  }, [followId]);

  if (n === 0) return null;
  let index = shownId ? ordered.findIndex((p) => p._id === shownId) : -1;
  if (index < 0) index = n - 1;
  const current = ordered[index];
  const senderKey = typeof current.senderId === "string" ? current.senderId : current.senderId._id;
  const who = senderKey === currentUserId ? "You" : senderName(current.senderId);
  const snippet = pinSnippet(current, currentUserId);

  function handleTap() {
    tappedAtRef.current = Date.now();
    onJump(current._id);
    // Then step to the previous pin, wrapping around to the newest.
    setShownId(ordered[(index - 1 + n) % n]._id);
  }

  const visible = Math.min(n, VISIBLE_SEGMENTS);
  const windowStart = Math.min(Math.max(0, index - (visible - 1)), n - visible);

  return (
    <>
      <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-line bg-raised pe-1 lg:pe-3">
        <button
          type="button"
          onClick={handleTap}
          aria-label={`Pinned message${n > 1 ? ` ${index + 1} of ${n}` : ""}: ${who}, ${snippet}. Go to message`}
          className="focus-inset flex h-11 min-w-0 flex-1 items-center gap-2.5 ps-3 text-start transition-colors hover:bg-sunken lg:ps-5"
        >
          <span className="flex h-6 w-[2px] shrink-0 flex-col gap-[3px]" aria-hidden>
            {Array.from({ length: visible }, (_, k) => {
              const i = windowStart + k;
              return <span key={i} className={cn("min-h-0 flex-1 rounded-full transition-colors", i === index ? "bg-accent" : "bg-muted/35")} />;
            })}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="max-w-[40%] shrink-0 truncate text-[12.5px] font-medium text-muted" dir="auto">
              {who}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg-2" dir="auto">
              {snippet}
            </span>
          </span>
        </button>
        {n > 1 ? (
          <IconButton size="sm" aria-label={`All ${n} pinned messages`} onClick={() => setListOpen(true)} className="text-muted">
            <ListOrdered strokeWidth={1.8} />
          </IconButton>
        ) : canUnpin ? (
          <IconButton size="sm" aria-label="Unpin message" onClick={() => setConfirmUnpin(true)} className="text-muted">
            <X strokeWidth={1.8} />
          </IconButton>
        ) : null}
      </div>
      {listOpen ? (
        <PinnedMessagesScreen
          pins={ordered}
          currentUserId={currentUserId}
          canUnpin={canUnpin}
          onClose={() => setListOpen(false)}
          onJump={(id) => {
            setListOpen(false);
            tappedAtRef.current = Date.now();
            setShownId(id);
            onJump(id);
          }}
          onUnpin={onUnpin}
        />
      ) : null}
      {confirmUnpin ? (
        <ConfirmDialog
          title="Unpin this message?"
          confirmLabel="Unpin"
          onClose={() => setConfirmUnpin(false)}
          onConfirm={() => {
            setConfirmUnpin(false);
            void onUnpin([current._id]);
          }}
        />
      ) : null}
    </>
  );
}
