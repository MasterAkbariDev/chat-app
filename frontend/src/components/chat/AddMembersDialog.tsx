"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Search, SearchX, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Field";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { addMembers, getInviteCode, getOrCreateDirect } from "@/lib/api/chats";
import { getRestrictedForGroups, searchUsers } from "@/lib/api/users";
import { getSocket } from "@/lib/socket";
import { FIND_BY_USERNAME_HINT } from "@/hooks/use-global-search";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import type { PublicUser } from "@/lib/api/types";

export interface AddMembersDialogProps {
  channelId: string;
  /** Current participant ids — search results already in the chat are
   *  filtered out rather than shown disabled, since re-adding an existing
   *  member isn't a real action here (the endpoint would just report them
   *  back under `skipped`). */
  existingUserIds: string[];
  onClose: () => void;
  onAdded: (added: PublicUser[]) => void;
  /** You may share this chat's invite link (offered to people whose privacy
   *  doesn't let you add them). */
  canShareInvite?: boolean;
}

/** Sends this chat's invite link to each person in a direct chat — what
 * Telegram offers when someone's privacy doesn't let you add them. */
async function sendInviteLinks(channelId: string, userIds: string[]) {
  const { inviteCode } = await getInviteCode(channelId);
  const link = `${window.location.origin}/app/join/${inviteCode}`;
  const socket = getSocket();
  if (!socket) throw new Error("offline");
  for (const userId of userIds) {
    const dm = await getOrCreateDirect(userId);
    await new Promise<void>((resolve, reject) => {
      socket.emit("send_message", { channelId: dm._id, content: link, type: "text" }, (ack: { error?: unknown } | object) =>
        "error" in ack && ack.error ? reject(new Error(String(ack.error))) : resolve(),
      );
    });
  }
}

function fullNameOf(u: Pick<PublicUser, "firstName" | "lastName" | "username">) {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;
}

// Deliberately not the full /app/new flow (no direct/group/channel tabs, no
// name field) — this only ever adds people to a chat that already exists,
// reusing just its search-and-multi-select shape for a consistent feel.
export function AddMembersDialog({ channelId, existingUserIds, onClose, onAdded, canShareInvite }: AddMembersDialogProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Debounced and trimmed, so typing a name is one request rather than one
  // per keystroke (and "ma" / "ma " share a cache entry).
  const term = useDebouncedValue(query.trim(), 300);
  const searchQuery = useQuery({
    queryKey: ["users", "search", term],
    queryFn: () => searchUsers(term),
    enabled: term.length >= 2,
  });
  const existing = new Set(existingUserIds);
  const results = (searchQuery.data ?? []).filter((u) => !existing.has(u._id));
  // "Groups & channels" privacy: who in these results won't let you add them.
  const resultIds = results.map((u) => u._id).sort();
  const restrictedQuery = useQuery({
    queryKey: ["users", "addable", resultIds],
    queryFn: () => getRestrictedForGroups(resultIds),
    enabled: resultIds.length > 0,
    staleTime: 30_000,
  });
  const restrictedIds = new Set(restrictedQuery.data?.restricted ?? []);
  // People the server refused on the last add (their privacy), to offer the invite link.
  const [refused, setRefused] = useState<PublicUser[]>([]);
  const [inviteState, setInviteState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  const mutation = useMutation({
    mutationFn: () => addMembers(channelId, selected.map((u) => u._id)),
    onSuccess: (res) => {
      const addedSet = new Set(res.added);
      onAdded(selected.filter((u) => addedSet.has(u._id)));
      const restricted = new Set(res.restricted ?? []);
      const blocked = selected.filter((u) => restricted.has(u._id));
      if (blocked.length) {
        setRefused(blocked);
        setSelected([]);
        setInviteState("idle");
        return;
      }
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Couldn't add them. Check your connection and try again."),
  });

  const inviteMutation = useMutation({
    mutationFn: () => sendInviteLinks(channelId, refused.map((u) => u._id)),
    onMutate: () => setInviteState("sending"),
    onSuccess: () => setInviteState("sent"),
    onError: () => setInviteState("failed"),
  });

  function toggle(u: PublicUser) {
    setSelected((prev) => (prev.some((s) => s._id === u._id) ? prev.filter((s) => s._id !== u._id) : [...prev, u]));
  }

  const count = selected.length;

  return (
    <Dialog
      onClose={onClose}
      title="Add members"
      size="md"
      className="sm:h-[min(640px,85dvh)]"
      bodyClassName="flex flex-col gap-3 px-0 pb-3 pt-2"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={mutation.isPending} disabled={count === 0} onClick={() => mutation.mutate()}>
            {count === 0 ? "Add people" : `Add ${count} ${count === 1 ? "person" : "people"}`}
          </Button>
        </>
      }
    >
      <div className="px-5">
        <PeopleSearchInput value={query} onChange={setQuery} label="Search people to add" />
      </div>

      <SelectedChips people={selected} onRemove={toggle} className="px-5" />

      {error ? (
        <div role="alert" className="mx-5 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
          {error}
        </div>
      ) : null}

      {refused.length ? (
        <div role="alert" className="mx-5 flex flex-col gap-2 rounded-[var(--radius-sm)] bg-sunken px-3 py-2.5 text-[13.5px] text-fg">
          <p>
            {refused.length === 1
              ? `${fullNameOf(refused[0])}'s privacy settings don't let you add them.`
              : `${refused.map(fullNameOf).join(", ")} have privacy settings that don't let you add them.`}{" "}
            {canShareInvite ? "You can send them an invite link instead." : null}
          </p>
          {canShareInvite ? (
            <div>
              <Button
                size="sm"
                variant="secondary"
                loading={inviteState === "sending"}
                disabled={inviteState === "sent"}
                onClick={() => inviteMutation.mutate()}
              >
                {inviteState === "sent" ? "Invite link sent" : "Send invite link"}
              </Button>
              {inviteState === "failed" ? <p className="mt-1 text-danger">Couldn&apos;t send it. Check your connection and try again.</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col px-2">
        {query.trim().length < 2 ? (
          <PickerHint text="Type at least 2 letters of a name or username." />
        ) : searchQuery.isPending || term !== query.trim() ? (
          <div role="status" aria-label="Searching">
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : searchQuery.isError ? (
          <PickerHint text="Search didn't load. Check your connection and try again." danger />
        ) : results.length === 0 && (searchQuery.data?.length ?? 0) > 0 ? (
          <PickerHint text={`Everyone matching “${query.trim()}” is already in this chat.`} />
        ) : results.length === 0 ? (
          <PickerHint icon text={`No one found for “${query.trim()}”. ${query.trim().startsWith("@") ? "Check the username and try again." : FIND_BY_USERNAME_HINT}`} />
        ) : (
          <div role="group" aria-label="Search results">
            {results.map((u) => (
              <PersonPickerRow
                key={u._id}
                user={u}
                checked={selected.some((s) => s._id === u._id)}
                onToggle={() => toggle(u)}
                unavailable={restrictedIds.has(u._id) ? "Can't be added — their privacy settings" : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* ---- Shared person-picker pieces (also used by /app/new) ---------------- */

export function PeopleSearchInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute start-3.5 top-1/2 size-[18px] -translate-y-1/2 text-muted" strokeWidth={1.8} aria-hidden />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        aria-label={label}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        data-autofocus
        className="ps-10"
      />
    </div>
  );
}

export function SelectedChips({ people, onRemove, className }: { people: PublicUser[]; onRemove: (u: PublicUser) => void; className?: string }) {
  if (people.length === 0) return null;
  return (
    <ul aria-label={`${people.length} selected`} className={cn("flex flex-wrap gap-1.5", className)}>
      {people.map((u) => {
        const name = fullNameOf(u);
        return (
          <li key={u._id}>
            <button
              type="button"
              onClick={() => onRemove(u)}
              aria-label={`Remove ${name}`}
              className="pressable inline-flex h-8 max-w-[200px] items-center gap-1.5 rounded-full bg-accent-soft pe-2 ps-1 text-[13px] font-semibold text-accent-text hover:brightness-[0.97]"
            >
              <Avatar colorId={u._id} name={name} src={u.avatarUrl?.[0]} size={24} />
              <span className="truncate">{name}</span>
              <X className="size-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One selectable person. `mode="multi"` is a checkbox, `"single"` a radio
 * (the caller wraps single-mode rows in a `role="radiogroup"`). */
export function PersonPickerRow({
  user,
  checked,
  onToggle,
  mode = "multi",
  unavailable,
}: {
  user: PublicUser;
  checked: boolean;
  onToggle: () => void;
  mode?: "multi" | "single";
  /** Why this person can't be picked (e.g. their privacy) — the row stays
   *  visible, dimmed and inert, with this in place of the username. */
  unavailable?: string;
}) {
  const name = fullNameOf(user);
  return (
    <button
      type="button"
      role={mode === "multi" ? "checkbox" : "radio"}
      aria-checked={checked}
      aria-disabled={unavailable ? true : undefined}
      onClick={unavailable ? undefined : onToggle}
      className={cn(
        "focus-inset flex min-h-[60px] w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-start transition-colors duration-[var(--dur-fast)]",
        unavailable ? "cursor-not-allowed opacity-55" : checked ? "bg-accent-soft" : "hover:bg-sunken",
      )}
    >
      <Avatar colorId={user._id} name={name} src={user.avatarUrl?.[0]} size={44} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-fg">{name}</span>
        <span className="block truncate text-[13.5px] text-muted">{unavailable ?? `@${user.username}`}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center border-2 transition-colors duration-[var(--dur-fast)]",
          mode === "multi" ? "rounded-[7px]" : "rounded-full",
          checked ? "border-accent bg-accent text-accent-fg" : "border-line-strong bg-transparent",
        )}
      >
        {checked ? <Check className="size-4" strokeWidth={3} /> : null}
      </span>
    </button>
  );
}

export function PickerHint({ text, icon, danger }: { text: string; icon?: boolean; danger?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      {icon ? <SearchX className="size-6 text-muted" strokeWidth={1.8} aria-hidden /> : null}
      <p className={cn("max-w-[300px] text-[14px] leading-relaxed", danger ? "text-danger" : "text-muted")}>{text}</p>
    </div>
  );
}
