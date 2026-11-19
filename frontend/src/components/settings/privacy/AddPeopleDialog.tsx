"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { PeopleSearchInput, PersonPickerRow, PickerHint, SelectedChips } from "@/components/chat/AddMembersDialog";
import { useAuth } from "@/contexts/auth-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { CHANNELS_QUERY_KEY, getChannelsMine } from "@/lib/api/chats";
import { getContacts } from "@/lib/api/contacts";
import { searchUsers } from "@/lib/api/users";
import type { PublicUser } from "@/lib/api/types";

function nameOf(u: PublicUser) {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;
}

/**
 * "Add users" for a privacy exception list: your contacts and the people you
 * have direct chats with, plus search for anyone else you know.
 */
export function AddPeopleDialog({
  title,
  exclude,
  onClose,
  onAdd,
}: {
  title: string;
  /** Already on this list (hidden from the picker). */
  exclude: string[];
  onClose: () => void;
  onAdd: (people: PublicUser[]) => void;
}) {
  const { user: me } = useAuth();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const contactsQuery = useQuery({ queryKey: ["contacts"], queryFn: getContacts });
  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine() });
  const term = useDebouncedValue(query.trim(), 300);
  const searchQuery = useQuery({
    queryKey: ["users", "search", term],
    queryFn: () => searchUsers(term),
    enabled: term.length >= 2,
  });

  const hidden = useMemo(() => new Set([...exclude, me?._id ?? ""]), [exclude, me?._id]);
  const known = useMemo(() => {
    const byId = new Map<string, PublicUser>();
    for (const c of contactsQuery.data ?? []) byId.set(c.user._id, c.customName ? { ...c.user, firstName: c.customName, lastName: "" } : c.user);
    for (const ch of channelsQuery.data?.items ?? []) if (ch.type === "private" && ch.otherUser && !byId.has(ch.otherUser._id)) byId.set(ch.otherUser._id, ch.otherUser);
    return [...byId.values()].filter((u) => !hidden.has(u._id)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }, [contactsQuery.data, channelsQuery.data, hidden]);

  const q = query.trim().replace(/^@/, "").toLowerCase();
  const people = useMemo(() => {
    if (!q) return known;
    const local = known.filter((u) => nameOf(u).toLowerCase().includes(q) || u.username.toLowerCase().includes(q));
    const seen = new Set(local.map((u) => u._id));
    const remote = (searchQuery.data ?? []).filter((u) => !hidden.has(u._id) && !seen.has(u._id));
    return [...local, ...remote];
  }, [q, known, searchQuery.data, hidden]);

  const loading = contactsQuery.isPending || channelsQuery.isPending;
  const searching = q.length >= 2 && (searchQuery.isPending || term !== query.trim());

  function toggle(u: PublicUser) {
    setSelected((prev) => (prev.some((s) => s._id === u._id) ? prev.filter((s) => s._id !== u._id) : [...prev, u]));
  }

  return (
    <Dialog
      onClose={onClose}
      title={title}
      size="md"
      className="sm:h-[min(640px,85dvh)]"
      bodyClassName="flex flex-col gap-3 px-0 pb-3 pt-2"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={() => {
              onAdd(selected);
              onClose();
            }}
          >
            {selected.length === 0 ? "Add" : `Add ${selected.length}`}
          </Button>
        </>
      }
    >
      <div className="px-5">
        <PeopleSearchInput value={query} onChange={setQuery} label="Search contacts and chats" />
      </div>
      <SelectedChips people={selected} onRemove={toggle} className="px-5" />
      <div className="flex flex-col px-2">
        {loading ? (
          <div role="status" aria-label="Loading people">
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : people.length === 0 && searching ? (
          <div role="status" aria-label="Searching">
            <SkeletonRow />
          </div>
        ) : people.length === 0 ? (
          <PickerHint icon text={q ? `No one found for “${query.trim()}”.` : "Your contacts and the people you chat with show up here."} />
        ) : (
          <div role="group" aria-label="People">
            {people.map((u) => (
              <PersonPickerRow key={u._id} user={u} checked={selected.some((s) => s._id === u._id)} onToggle={() => toggle(u)} />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
