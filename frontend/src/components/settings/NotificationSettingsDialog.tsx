"use client";

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { useAuth } from "@/contexts/auth-context";
import { ApiError } from "@/lib/api/client";
import { updateNotificationLevel } from "@/lib/api/users";
import { cn } from "@/lib/cn";
import type { NotificationLevel } from "@/lib/api/types";

export interface NotificationSettingsDialogProps {
  onClose: () => void;
}

const OPTIONS: { value: NotificationLevel; label: string; hint: string }[] = [
  { value: "all", label: "All messages", hint: "A notification for every new message" },
  { value: "mentions", label: "Mentions only", hint: "Only when someone @mentions you" },
  { value: "none", label: "None", hint: "No push notifications — messages still arrive live while the app is open" },
];

// PATCH /users/notifications only returns `{success}`, not the updated
// user, and GET /auth/me previously didn't expose notificationLevel at all
// (added alongside this feature) — so this is entirely about *push*
// delivery, separate from per-chat mute (see ChatInfoPanel's mute toggle,
// which is enforced independently server-side).
export function NotificationSettingsDialog({ onClose }: NotificationSettingsDialogProps) {
  const { user, updateUser } = useAuth();
  const [selected, setSelected] = useState<NotificationLevel>(user?.notificationLevel ?? "all");
  const [error, setError] = useState<string | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const mutation = useMutation({
    mutationFn: (level: NotificationLevel) => updateNotificationLevel(level),
    onSuccess: (_res, level) => {
      updateUser({ notificationLevel: level });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't save that. Check your connection and try again."),
  });

  function choose(level: NotificationLevel) {
    setSelected(level);
    setError(null);
    mutation.mutate(level);
  }

  // Picking an option saves it immediately (and closes), so arrow keys only
  // move focus between options; Enter/Space is what actually picks one.
  // Every option stays a Tab stop too — Dialog's focus trap treats the last
  // <button> as the wrap point, so a roving tabindex would let Tab escape.
  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    refs.current[(index + delta + OPTIONS.length) % OPTIONS.length]?.focus();
  }

  return (
    <Dialog onClose={onClose} title="Push notifications" description="When should we send you a notification?">
      <div role="radiogroup" aria-label="Push notifications" className="flex flex-col gap-2 pb-2">
        {OPTIONS.map((opt, i) => {
          const isSelected = selected === opt.value;
          const saving = mutation.isPending && mutation.variables === opt.value;
          return (
            <button
              key={opt.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={isSelected}
              data-autofocus={isSelected ? true : undefined}
              onClick={() => choose(opt.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              disabled={mutation.isPending}
              className={cn(
                "pressable flex min-h-[64px] items-center gap-3 rounded-[var(--radius-md)] border px-4 py-3 text-start transition-colors duration-[var(--dur-fast)] disabled:opacity-60",
                isSelected ? "border-accent bg-accent-soft" : "border-line bg-panel hover:border-line-strong hover:bg-sunken",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border-2",
                  isSelected ? "border-accent bg-accent text-accent-fg" : "border-line-strong",
                )}
              >
                {isSelected ? <Check className="size-3" strokeWidth={3} /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-fg">{opt.label}</span>
                <span className="mt-0.5 block text-[13px] leading-snug text-muted">{opt.hint}</span>
              </span>
              {saving ? <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent text-muted" aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      {error ? (
        <p role="alert" className="pb-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
