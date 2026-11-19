"use client";

import { useId, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";

/** One delete for one or many messages. The checkbox (only when they can be removed for everyone)
 *  also removes them for the other side: "Also delete for everyone", or "Also delete for <name>"
 *  in a direct chat. Off, they're removed for you only. */
export function DeleteMessagesDialog({
  count,
  canEveryone,
  everyoneLabel,
  onConfirm,
  onClose,
}: {
  count: number;
  canEveryone: boolean;
  everyoneLabel: string;
  onConfirm: (forEveryone: boolean) => void;
  onClose: () => void;
}) {
  const [everyone, setEveryone] = useState(false);
  const checkId = useId();
  const title = count === 1 ? "Delete message?" : `Delete ${count} messages?`;
  return (
    <Dialog
      onClose={onClose}
      title={title}
      description={everyone ? "They'll be removed for everyone in this chat. This can't be undone." : "They'll be removed from your chat. This can't be undone."}
      onSubmit={() => onConfirm(canEveryone && everyone)}
      footer={
        <>
          <button type="button" onClick={onClose} className="pressable h-11 rounded-[var(--radius-sm)] border border-line bg-sunken px-4 text-[15px] font-semibold text-fg hover:border-line-strong">
            Cancel
          </button>
          <button type="submit" className="pressable inline-flex h-11 items-center justify-center rounded-[var(--radius-sm)] bg-danger px-4 text-[15px] font-semibold text-canvas hover:brightness-110" data-autofocus>
            Delete
          </button>
        </>
      }
    >
      {canEveryone ? (
        <label htmlFor={checkId} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] px-1 text-[15px] text-fg">
          <input
            id={checkId}
            type="checkbox"
            checked={everyone}
            onChange={(e) => setEveryone(e.target.checked)}
            className="size-5 shrink-0 cursor-pointer accent-accent"
          />
          {everyoneLabel}
        </label>
      ) : null}
    </Dialog>
  );
}
