"use client";

import { useState } from "react";
import { useRouter } from "@/hooks/use-app-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Megaphone, MessageCircle, Users, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { PhotoPicker } from "@/components/ui/PhotoPicker";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { CHAT_LINK_HINT, CHAT_LINK_PATTERN, LinkInput } from "@/components/chat/EditChatDialog";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { PeopleSearchInput, PersonPickerRow, PickerHint, SelectedChips } from "@/components/chat/AddMembersDialog";
import { cn } from "@/lib/cn";
import { CHANNELS_QUERY_KEY, createChat, getOrCreateDirect, type CreateChatInput } from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import { getRestrictedForGroups, searchUsers } from "@/lib/api/users";
import { FIND_BY_USERNAME_HINT } from "@/hooks/use-global-search";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useAuth } from "@/contexts/auth-context";
import type { PublicUser } from "@/lib/api/types";

type Tab = "direct" | "group" | "channel";

const TYPES: { key: Tab; label: string; description: string; icon: LucideIcon }[] = [
  { key: "direct", label: "Message", description: "A private chat between you and one other person.", icon: MessageCircle },
  { key: "group", label: "Group", description: "Talk with several people in one place.", icon: Users },
  { key: "channel", label: "Channel", description: "Share updates and announcements with a bigger audience.", icon: Megaphone },
];

const COPY: Record<Tab, { search: string; list: string }> = {
  // Names only match people you already know; strangers are found by their
  // @username (never email/phone — see searchUsers).
  direct: { search: "Search by name or @username", list: "Choose a person" },
  group: { search: "Search people to add", list: "Add members" },
  channel: { search: "Search people to add", list: "Add members (optional)" },
};

type Visibility = "public" | "private";

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${base || "chat"}-${suffix}`;
}

function fullNameOf(u: PublicUser) {
  return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;
}

export default function NewConversationPage() {
  const [tab, setTab] = useState<Tab>("direct");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PublicUser[]>([]);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const isGroupLike = tab === "group" || tab === "channel";
  const copy = COPY[tab];
  // Channels can start empty (people join by link or search); groups need someone to talk to.
  const canSubmit = tab === "direct" ? selected.length > 0 : tab === "channel" ? name.trim().length > 0 : selected.length > 0;

  // Debounced and trimmed, so typing a name is one request rather than one
  // per keystroke (and "ma" / "ma " share a cache entry).
  const term = useDebouncedValue(query.trim(), 300);
  const searchQuery = useQuery({
    queryKey: ["users", "search", term],
    queryFn: () => searchUsers(term),
    enabled: term.length >= 2,
  });

  const results = (searchQuery.data ?? []).filter((u) => u._id !== me?._id);
  // "Groups & channels" privacy: people who won't let you add them show as unavailable.
  const resultIds = results.map((u) => u._id).sort();
  const restrictedQuery = useQuery({
    queryKey: ["users", "addable", resultIds],
    queryFn: () => getRestrictedForGroups(resultIds),
    enabled: tab !== "direct" && resultIds.length > 0,
    staleTime: 30_000,
  });
  const restrictedIds = new Set(tab !== "direct" ? (restrictedQuery.data?.restricted ?? []) : []);

  function toggleSelected(u: PublicUser) {
    setError(null);
    setSelected((prev) => (prev.some((s) => s._id === u._id) ? prev.filter((s) => s._id !== u._id) : [...prev, u]));
  }

  function changeTab(next: Tab) {
    setTab(next);
    setError(null);
    setNameError(null);
    setLinkError(null);
    // A direct chat only ever uses the first pick (see handleSubmit), so
    // don't leave extra people looking selected.
    if (next === "direct") setSelected((prev) => prev.slice(0, 1));
  }

  async function handleSubmit() {
    // The name field's Enter key bypasses the (loading-disabled) button.
    if (submitting || uploading) return;
    setError(null);
    setNameError(null);
    setLinkError(null);
    setSubmitting(true);
    try {
      if (tab === "direct") {
        const other = selected[0];
        if (!other) return;
        const chat = await getOrCreateDirect(other._id);
        await queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
        router.push(`/app/c/${chat._id}`);
        return;
      }
      if (isGroupLike) {
        if (!name.trim() || (tab === "group" && selected.length === 0)) {
          if (!name.trim()) setNameError(`Give your ${tab} a name.`);
          else setError("Add at least one person.");
          return;
        }
        const isPublic = visibility === "public";
        const publicLink = link.trim().replace(/^@/, "");
        if (isPublic && !CHAT_LINK_PATTERN.test(publicLink)) {
          setLinkError(publicLink ? `The link can use ${CHAT_LINK_HINT.toLowerCase()}` : "A public link is needed so people can find it.");
          return;
        }
        const input: CreateChatInput = {
          name: name.trim(),
          link: isPublic ? publicLink : slugify(name),
          type: tab as "group" | "channel",
          members: selected.map((u) => u._id),
          isPublic,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(photo ? { imageUrl: [photo] } : {}),
        };
        let chat;
        try {
          chat = await createChat(input);
        } catch (err) {
          // A taken public link is the usual failure — show it on the field.
          if (isPublic && err instanceof ApiError && (err.status === 409 || /link|already|taken/i.test(err.message))) {
            setLinkError(/already|taken/i.test(err.message) || err.status === 409 ? "That link is already taken. Try another one." : err.message);
            return;
          }
          throw err;
        }
        await queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
        router.push(`/app/c/${chat._id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create it. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const current = TYPES.find((t) => t.key === tab)!;
  const cta =
    tab === "direct"
      ? selected[0]
        ? `Message ${fullNameOf(selected[0])}`
        : "Choose someone to message"
      : tab === "group"
        ? "Create group"
        : "Create channel";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title="New conversation" backHref="/app" />

      <PageBody width="sm" className="gap-6 pb-8 lg:pb-8">
        <section className="flex flex-col gap-2">
          <div role="radiogroup" aria-label="Conversation type" className="grid grid-cols-3 gap-2">
            {TYPES.map((t) => {
              const checked = t.key === tab;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => changeTab(t.key)}
                  onKeyDown={(e) => {
                    const i = TYPES.findIndex((x) => x.key === tab);
                    let next = -1;
                    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % TYPES.length;
                    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + TYPES.length) % TYPES.length;
                    if (next < 0) return;
                    e.preventDefault();
                    changeTab(TYPES[next].key);
                    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
                  }}
                  className={cn(
                    "pressable flex min-h-[84px] flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border px-2 py-3 text-[14px] font-semibold transition-colors duration-[var(--dur-fast)]",
                    checked
                      ? "border-accent bg-accent-soft text-accent-text"
                      : "border-line bg-panel text-fg hover:border-line-strong hover:bg-sunken",
                  )}
                >
                  <t.icon className="size-[22px]" strokeWidth={1.9} aria-hidden />
                  {t.label}
                </button>
              );
            })}
          </div>
          <p className="px-1 text-[13.5px] leading-relaxed text-muted" aria-live="polite">
            {current.description}
          </p>
        </section>

        {isGroupLike ? (
          <section aria-label={tab === "channel" ? "Channel details" : "Group details"} className="flex flex-col gap-4">
            <PhotoPicker
              value={photo}
              onChange={setPhoto}
              onUploadingChange={setUploading}
              name={name.trim() || (tab === "channel" ? "Channel" : "Group")}
              colorId={`new-${tab}`}
              shape="square"
              size={88}
            />
            <Field
              label={tab === "channel" ? "Channel name" : "Group name"}
              error={nameError ?? undefined}
            >
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (nameError) setNameError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (canSubmit) handleSubmit();
                  }
                }}
                placeholder="e.g. Weekend trip"
                autoComplete="off"
                enterKeyHint="done"
                maxLength={100}
              />
            </Field>

            <Field label="Description (optional)">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
                rows={2}
                dir="auto"
                placeholder={`What's this ${tab} about?`}
              />
            </Field>

            <div className="flex flex-col gap-2">
              <span className="text-[13.5px] font-semibold text-fg-2">Who can join</span>
              <SegmentedTabs<Visibility>
                aria-label="Who can join"
                options={[
                  { key: "private", label: "Private" },
                  { key: "public", label: "Public" },
                ]}
                value={visibility}
                onChange={(v) => {
                  setVisibility(v);
                  setLinkError(null);
                }}
              />
              <p className="text-[12.5px] leading-snug text-muted">
                {visibility === "private"
                  ? "Private: people join with an invite link, which is made for you automatically."
                  : "Public: anyone can find it in search and join."}
              </p>
            </div>

            {visibility === "public" ? (
              <Field label="Public link" hint={`People can find it as @link. ${CHAT_LINK_HINT}`} error={linkError ?? undefined}>
                <LinkInput
                  value={link}
                  onChange={(v) => {
                    setLink(v);
                    if (linkError) setLinkError(null);
                  }}
                />
              </Field>
            ) : null}
          </section>
        ) : null}

        <section className="flex flex-col gap-3" aria-labelledby="people-heading">
          <div className="flex items-baseline justify-between gap-2 px-1">
            <h2 id="people-heading" className="text-[13.5px] font-semibold text-muted">
              {copy.list}
            </h2>
            {isGroupLike && selected.length > 0 ? (
              <span className="tabular text-[13px] text-muted">{selected.length} selected</span>
            ) : null}
          </div>

          <PeopleSearchInput value={query} onChange={setQuery} label={copy.search} />

          {isGroupLike ? <SelectedChips people={selected} onRemove={toggleSelected} /> : null}

          <div className="-mx-2 flex flex-col">
            {query.trim().length < 2 ? (
              <PickerHint text="Type at least 2 letters of a name or username." />
            ) : searchQuery.isPending || term !== query.trim() ? (
              <div role="status" aria-label="Searching">
                <SkeletonRow />
                <SkeletonRow />
              </div>
            ) : searchQuery.isError ? (
              <PickerHint text="Search didn't load. Check your connection and try again." danger />
            ) : results.length === 0 ? (
              <PickerHint icon text={`No one found for “${query.trim()}”. ${query.trim().startsWith("@") ? "Check the username and try again." : FIND_BY_USERNAME_HINT}`} />
            ) : (
              <div role={isGroupLike ? "group" : "radiogroup"} aria-label="Search results">
                {results.map((u) => (
                  <PersonPickerRow
                    key={u._id}
                    user={u}
                    mode={isGroupLike ? "multi" : "single"}
                    checked={selected.some((s) => s._id === u._id)}
                    onToggle={() => (isGroupLike ? toggleSelected(u) : setSelected([u]))}
                    unavailable={restrictedIds.has(u._id) ? "Can't be added — their privacy settings" : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </PageBody>

      <div className="shrink-0 border-t border-line bg-panel px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 lg:px-6">
        <div className="mx-auto flex w-full max-w-[480px] flex-col gap-2">
          {error ? (
            <p role="alert" className="text-center text-[13.5px] text-danger">
              {error}
            </p>
          ) : null}
          <Button size="lg" block loading={submitting} disabled={!canSubmit || uploading} onClick={handleSubmit}>
            <span className="truncate">{cta}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
