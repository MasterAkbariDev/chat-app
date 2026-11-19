"use client";

import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Folder, ListFilter, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { Field, Input } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { ListGroup } from "@/components/ui/List";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { TagInput } from "@/components/ui/TagInput";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChannelPickerDialog } from "@/components/settings/ChannelPickerDialog";
import { ApiError } from "@/lib/api/client";
import { getChannelsMine } from "@/lib/api/chats";
import { FOLDERS_QUERY_KEY, createFolder, deleteFolder, getFolders, updateFolder } from "@/lib/api/folders";
import { channelDisplayName, type ChatFolder, type ChatKind } from "@/lib/api/types";

const TYPE_OPTIONS: { key: ChatKind; label: string }[] = [
  { key: "private", label: "Private" },
  { key: "group", label: "Groups" },
  { key: "channel", label: "Channels" },
  { key: "saved_messages", label: "Saved" },
];

function summarize(folder: ChatFolder): string {
  const parts: string[] = [];
  if (folder.filters.includeTypes.length) {
    parts.push(folder.filters.includeTypes.map((t) => TYPE_OPTIONS.find((o) => o.key === t)?.label ?? t).join(", "));
  }
  if (folder.filters.onlyUnread) parts.push("Unread only");
  if (folder.filters.includeTags.length) parts.push(`Tags: ${folder.filters.includeTags.join(", ")}`);
  if (folder.filters.includeChannelIds.length) parts.push(`${folder.filters.includeChannelIds.length} pinned in`);
  if (folder.filters.excludeChannelIds.length) parts.push(`${folder.filters.excludeChannelIds.length} pinned out`);
  return parts.length ? parts.join(" · ") : "All chats";
}

interface DraftState {
  name: string;
  types: ChatKind[];
  onlyUnread: boolean;
  tags: string[];
  includeChannelIds: string[];
  excludeChannelIds: string[];
}

const EMPTY_DRAFT: DraftState = { name: "", types: [], onlyUnread: false, tags: [], includeChannelIds: [], excludeChannelIds: [] };

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** A labelled group of non-text controls (chips, pickers) — a real
 * fieldset/legend, since `Field`'s <label htmlFor> only fits one input. */
function FieldGroup({ legend, hint, children }: { legend: string; hint?: string; children: React.ReactNode }) {
  const hintId = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={hint ? hintId : undefined}>
      <legend className="mb-0.5 text-[13.5px] font-semibold text-fg-2">{legend}</legend>
      {children}
      {hint ? (
        <p id={hintId} className="text-[12.5px] leading-snug text-muted">
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}

export default function ChatFoldersSettingsPage() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState<"new" | string | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [picking, setPicking] = useState<"include" | "exclude" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatFolder | null>(null);
  const onlyUnreadId = useId();

  const foldersQuery = useQuery({ queryKey: FOLDERS_QUERY_KEY, queryFn: getFolders });
  const folders = foldersQuery.data ?? [];

  // Same shape as the picker's own query — shares its cache entry so
  // choosing chats then re-opening the picker doesn't refetch, and this
  // page can resolve ids to real chat names for the chip rows below.
  const allChannelsQuery = useQuery({
    queryKey: ["channels", "mine", "all"],
    queryFn: async () => {
      const items = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await getChannelsMine({ cursor });
        items.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return items;
    },
  });
  const channelName = useMemo(() => {
    const map = new Map((allChannelsQuery.data ?? []).map((c) => [c.channelId, channelDisplayName(c)]));
    return (channelId: string) => map.get(channelId) ?? "Unknown chat";
  }, [allChannelsQuery.data]);

  // The chat list caches each folder tab's membership separately
  // (ConversationList's ["channels", "folder-members", id]) — refresh those
  // too, or an edited folder's tab keeps showing its old set of chats.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: ["channels", "folder-members"] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      createFolder(draft.name.trim(), {
        includeTypes: draft.types,
        onlyUnread: draft.onlyUnread,
        includeTags: draft.tags,
        includeChannelIds: draft.includeChannelIds,
        excludeChannelIds: draft.excludeChannelIds,
      }),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: (folderId: string) =>
      updateFolder(folderId, {
        name: draft.name.trim(),
        filters: {
          includeTypes: draft.types,
          onlyUnread: draft.onlyUnread,
          includeTags: draft.tags,
          includeChannelIds: draft.includeChannelIds,
          excludeChannelIds: draft.excludeChannelIds,
        },
      }),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (folderId: string) => deleteFolder(folderId),
    onSuccess: invalidate,
  });

  // Reordering is just swapping two adjacent folders' `order` — no drag
  // library needed for a short, occasionally-reordered list like this.
  const reorderMutation = useMutation({
    mutationFn: ({ a, b }: { a: ChatFolder; b: ChatFolder }) =>
      Promise.all([updateFolder(a._id, { order: b.order }), updateFolder(b._id, { order: a.order })]),
    onSuccess: invalidate,
  });

  function openNew() {
    createMutation.reset();
    updateMutation.reset();
    setDraft(EMPTY_DRAFT);
    setFormOpen("new");
  }

  function openEdit(folder: ChatFolder) {
    createMutation.reset();
    updateMutation.reset();
    setDraft({
      name: folder.name,
      types: folder.filters.includeTypes,
      onlyUnread: folder.filters.onlyUnread,
      tags: folder.filters.includeTags,
      includeChannelIds: folder.filters.includeChannelIds,
      excludeChannelIds: folder.filters.excludeChannelIds,
    });
    setFormOpen(folder._id);
  }

  function closeForm() {
    setFormOpen(null);
    setPicking(null);
    setDraft(EMPTY_DRAFT);
  }

  function submit() {
    if (!draft.name.trim()) return;
    if (formOpen === "new") createMutation.mutate();
    else if (formOpen) updateMutation.mutate(formOpen);
  }

  function toggleType(type: ChatKind) {
    setDraft((d) => ({ ...d, types: d.types.includes(type) ? d.types.filter((t) => t !== type) : [...d.types, type] }));
  }

  // The backend ANDs include with exclude on the same field, so a chat in
  // both lists is filtered out either way (exclude silently wins) — keep
  // the two lists mutually exclusive client-side so that dead state can't
  // even be created here.
  function applyPicked(kind: "include" | "exclude", ids: string[]) {
    setDraft((d) =>
      kind === "include"
        ? { ...d, includeChannelIds: ids, excludeChannelIds: d.excludeChannelIds.filter((id) => !ids.includes(id)) }
        : { ...d, excludeChannelIds: ids, includeChannelIds: d.includeChannelIds.filter((id) => !ids.includes(id)) },
    );
    setPicking(null);
  }

  function removePicked(kind: "include" | "exclude", channelId: string) {
    setDraft((d) =>
      kind === "include"
        ? { ...d, includeChannelIds: d.includeChannelIds.filter((id) => id !== channelId) }
        : { ...d, excludeChannelIds: d.excludeChannelIds.filter((id) => id !== channelId) },
    );
  }

  function move(index: number, dir: -1 | 1) {
    const target = folders[index + dir];
    if (!target) return;
    reorderMutation.mutate({ a: folders[index], b: target });
  }

  const saving = createMutation.isPending || updateMutation.isPending;
  const saveError = createMutation.error ?? updateMutation.error;
  const isNew = formOpen === "new";

  function renderPicked(kind: "include" | "exclude") {
    const ids = kind === "include" ? draft.includeChannelIds : draft.excludeChannelIds;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {ids.map((id) => {
          const name = channelName(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => removePicked(kind, id)}
              aria-label={`Remove ${name}`}
              className="pressable inline-flex h-8 max-w-full items-center gap-1 rounded-full bg-accent-soft pe-2 ps-3 text-[13px] font-semibold text-accent-text hover:brightness-[0.97]"
            >
              <span className="truncate">{name}</span>
              <X className="size-3.5 shrink-0" strokeWidth={2} aria-hidden />
            </button>
          );
        })}
        <Button variant="secondary" size="sm" onClick={() => setPicking(kind)}>
          <Plus className="size-4" strokeWidth={2} aria-hidden />
          {ids.length ? "Change chats" : "Choose chats"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader
        title="Chat folders"
        backHref="/app/settings"
        backLabel="Back to settings"
        backOnDesktop
        actions={
          folders.length > 0 ? (
            <Button size="sm" onClick={openNew}>
              <Plus className="size-4" strokeWidth={2} aria-hidden />
              New folder
            </Button>
          ) : undefined
        }
      />

      <PageBody>
        {foldersQuery.isPending ? (
          <div role="status" aria-label="Loading folders" className="divide-y divide-line overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel">
            {[0, 1, 2].map((i) => (
              <div key={i} aria-hidden className="flex min-h-[64px] items-center gap-3 px-4 py-2.5">
                <Skeleton className="size-9 shrink-0 rounded-[var(--radius-sm)]" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : foldersQuery.isError ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-[14px] text-danger">Couldn&apos;t load your folders.</p>
            <Button size="sm" variant="secondary" onClick={() => foldersQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : folders.length === 0 ? (
          <EmptyState
            icon={ListFilter}
            title="No folders yet"
            description="Folders are tabs above your chat list — like Family, Work or Unread — so the chats you want are one tap away."
            action={{ label: "Create a folder", onClick: openNew }}
          />
        ) : (
          <ListGroup
            title="Your folders"
            description={
              reorderMutation.isError || deleteMutation.isError ? (
                <span role="alert" className="text-danger">
                  {reorderMutation.isError
                    ? errorText(reorderMutation.error, "Couldn't reorder your folders. Try again.")
                    : errorText(deleteMutation.error, "Couldn't delete that folder. Try again.")}
                </span>
              ) : (
                "Folders appear as tabs above your chat list, in this order. A pinned-in chat still has to match type and tag filters, if any are set — pinning out always wins over pinning in."
              )
            }
          >
            {folders.map((folder, i) => (
              <div key={folder._id} className="flex min-h-[64px] items-center gap-2 py-2 pe-2 ps-2">
                <div className="flex shrink-0 flex-col">
                  <IconButton
                    size="sm"
                    onClick={() => move(i, -1)}
                    disabled={i === 0 || reorderMutation.isPending}
                    aria-label={`Move ${folder.name} up`}
                  >
                    <ArrowUp strokeWidth={1.8} aria-hidden />
                  </IconButton>
                  <IconButton
                    size="sm"
                    onClick={() => move(i, 1)}
                    disabled={i === folders.length - 1 || reorderMutation.isPending}
                    aria-label={`Move ${folder.name} down`}
                  >
                    <ArrowDown strokeWidth={1.8} aria-hidden />
                  </IconButton>
                </div>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-sunken text-fg-2">
                  <Folder className="size-[18px]" strokeWidth={1.8} aria-hidden />
                </span>
                <div className="min-w-0 flex-1 ps-1">
                  <div className="truncate text-[15px] font-medium text-fg">{folder.name}</div>
                  <div className="truncate text-[13px] text-muted">{summarize(folder)}</div>
                </div>
                <IconButton onClick={() => openEdit(folder)} aria-label={`Edit ${folder.name}`}>
                  <Pencil strokeWidth={1.8} aria-hidden />
                </IconButton>
                <IconButton variant="danger" onClick={() => setDeleteTarget(folder)} aria-label={`Delete ${folder.name}`}>
                  <Trash2 strokeWidth={1.8} aria-hidden />
                </IconButton>
              </div>
            ))}
          </ListGroup>
        )}
      </PageBody>

      {/* The chat picker stacks on top of the editor (Dialog's own stack
          means Esc only closes the topmost one). It used to *replace* the
          editor instead, which unmounted it — both dialogs then lost their
          focus-return target, so closing the editor dropped focus on <body>
          rather than back on the Edit / New folder button. */}
      {formOpen ? (
        <Dialog
          onClose={closeForm}
          onSubmit={submit}
          size="md"
          title={isNew ? "New folder" : "Edit folder"}
          description="Choose which chats show up in this folder."
          footer={
            <>
              <Button variant="secondary" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" loading={saving} disabled={!draft.name.trim()}>
                {isNew ? "Create folder" : "Save changes"}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-5 pb-1">
            <Field label="Name">
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="e.g. Family, Work, Unread"
                maxLength={50}
                autoComplete="off"
                autoFocus
                required
              />
            </Field>

            <FieldGroup legend="Show chats of type" hint="Leave all unselected to include every type.">
              <div className="flex flex-wrap gap-1.5">
                {TYPE_OPTIONS.map((o) => (
                  <Chip key={o.key} label={o.label} active={draft.types.includes(o.key)} onClick={() => toggleType(o.key)} />
                ))}
              </div>
            </FieldGroup>

            <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-line bg-panel px-4 py-3">
              <div className="min-w-0 flex-1">
                <div id={onlyUnreadId} className="text-[15px] font-medium text-fg">
                  Only show unread
                </div>
                <div className="text-[13px] text-muted">Hide chats once you&apos;ve read them</div>
              </div>
              <Switch checked={draft.onlyUnread} onChange={(v) => setDraft((d) => ({ ...d, onlyUnread: v }))} aria-labelledby={onlyUnreadId} />
            </div>

            <FieldGroup
              legend="Show chats tagged"
              hint="Matches a chat with any of these tags (set per chat from its info panel). Leave empty to ignore tags. Case-sensitive."
            >
              <TagInput aria-label="Tags to include" tags={draft.tags} onChange={(tags) => setDraft((d) => ({ ...d, tags }))} placeholder="Add a tag…" />
            </FieldGroup>

            <FieldGroup legend="Always include these chats" hint="Pinned in regardless of the type and tag filters above — but still hidden if also excluded below.">
              {renderPicked("include")}
            </FieldGroup>

            <FieldGroup legend="Always exclude these chats" hint="Hidden from this folder even if they match every filter above.">
              {renderPicked("exclude")}
            </FieldGroup>

            {saveError ? (
              <p role="alert" className="text-[13px] text-danger">
                {errorText(saveError, isNew ? "Couldn't create the folder. Try again." : "Couldn't save your changes. Try again.")}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      {picking ? (
        <ChannelPickerDialog
          title={picking === "include" ? "Always include" : "Always exclude"}
          initialSelectedIds={picking === "include" ? draft.includeChannelIds : draft.excludeChannelIds}
          onClose={() => setPicking(null)}
          onConfirm={(ids) => applyPicked(picking, ids)}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title={`Delete “${deleteTarget.name}”?`}
          description="The folder tab goes away. The chats in it aren't deleted — they stay in All chats."
          confirmLabel="Delete folder"
          destructive
          pending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteTarget._id, { onSettled: () => setDeleteTarget(null) })}
          onClose={() => (deleteMutation.isPending ? undefined : setDeleteTarget(null))}
        />
      ) : null}
    </div>
  );
}
