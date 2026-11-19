"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, MinusCircle, Plus, Search, Smile, Sticker, Trash2 } from "lucide-react";
import Link from "next/link";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { ListGroup } from "@/components/ui/List";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { PackImage } from "@/components/packs/PackImage";
import { PackPreviewSheet } from "@/components/packs/PackPreviewSheet";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ApiError } from "@/lib/api/client";
import { deletePack, getMyPacks, getPack, reorderMyPacks, searchPacks, subscribeToPack, unsubscribeFromPack } from "@/lib/api/packs";
import type { PackSummary, PackType } from "@/lib/api/types";
import { cn } from "@/lib/cn";

const mineKey = (type: PackType) => ["packs", "mine", type] as const;

function errorText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

/** The pack's first item as a still thumbnail (cached with the picker's own detail queries). */
function PackThumb({ pack }: { pack: PackSummary }) {
  const detail = useQuery({ queryKey: ["packs", "detail", pack.id], queryFn: () => getPack(pack.id), staleTime: 5 * 60_000 });
  const first = detail.data?.items[0];
  return (
    <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-sunken">
      {first ? (
        <PackImage thumbPath={first.stillPath ?? first.thumbPath ?? first.relativePath} alt="" className="size-9 object-contain" />
      ) : detail.isPending ? (
        <Skeleton className="size-9 rounded-[var(--radius-xs)]" />
      ) : pack.type === "sticker" ? (
        <Sticker className="size-5 text-muted" strokeWidth={1.8} aria-hidden />
      ) : (
        <Smile className="size-5 text-muted" strokeWidth={1.8} aria-hidden />
      )}
    </span>
  );
}

interface Undo {
  pack: PackSummary;
  /** The list's order before removal, to put it back where it was. */
  order: string[];
}

/** Settings → Stickers & emoji: your packs (open, reorder, remove — with
 * undo — or delete one you made) and "Find packs" to add public ones. */
export default function PacksSettingsPage() {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PackSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["packs", "mine"] });
    queryClient.invalidateQueries({ queryKey: ["packs", "detail"] });
    queryClient.invalidateQueries({ queryKey: ["packs", "search-items"] });
    queryClient.invalidateQueries({ queryKey: ["packs", "discover-settings"] });
  };

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  const remove = useMutation({
    mutationFn: ({ pack }: Undo) => unsubscribeFromPack(pack.id),
    onMutate: ({ pack }) => {
      setError(null);
      queryClient.setQueryData<PackSummary[]>(mineKey(pack.type), (prev) => (prev ?? []).filter((p) => p.id !== pack.id));
    },
    onSuccess: (_r, u) => {
      setUndo(u);
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndo(null), 6000);
    },
    onError: (err) => setError(errorText(err, "Couldn't remove that pack. Try again.")),
    onSettled: invalidate,
  });

  const restore = useMutation({
    mutationFn: async ({ pack, order }: Undo) => {
      await subscribeToPack(pack.id);
      await reorderMyPacks(order);
    },
    onMutate: () => {
      setUndo(null);
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    onError: (err) => setError(errorText(err, "Couldn't add that pack back. Try again.")),
    onSettled: invalidate,
  });

  const del = useMutation({
    mutationFn: (pack: PackSummary) => deletePack(pack.id),
    onMutate: () => setError(null),
    onError: (err) => setError(errorText(err, "Couldn't delete that pack. Try again.")),
    onSettled: invalidate,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title="Stickers & emoji" backHref="/app/settings" backLabel="Back to settings" backOnDesktop />
      <PageBody>
        <FindPacks onPreview={setPreview} />

        {error ? (
          <p role="alert" className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
            {error}
          </p>
        ) : null}

        {(["emoji", "sticker"] as const).map((type) => (
          <MyPackList
            key={type}
            type={type}
            onPreview={setPreview}
            onRemove={(pack, order) => remove.mutate({ pack, order })}
            onDelete={setConfirmDelete}
          />
        ))}

        <div className="flex flex-col items-start gap-2 px-1">
          <p className="text-[13.5px] text-muted">Make your own pack from your photos and stickers with the pack manager bot.</p>
          <Link href="/app/settings/bots" className={buttonClasses({ variant: "secondary", size: "sm" })}>
            <Plus className="size-4" strokeWidth={2} aria-hidden />
            Create a pack
          </Link>
        </div>
      </PageBody>

      {undo ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-[80] flex justify-center px-4 lg:bottom-8">
          <div role="status" className="pop-in pointer-events-auto flex items-center gap-3 rounded-full bg-fg py-1.5 pe-1.5 ps-4 text-[14px] font-medium text-canvas shadow-lg">
            <span className="max-w-[220px] truncate">Removed {undo.pack.name}</span>
            <button
              type="button"
              onClick={() => restore.mutate(undo)}
              className="pressable h-9 rounded-full px-3.5 text-[14px] font-semibold text-accent hover:bg-white/10"
            >
              Undo
            </button>
          </div>
        </div>
      ) : null}

      {preview ? <PackPreviewSheet packId={preview} onClose={() => setPreview(null)} /> : null}
      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete ${confirmDelete.name}?`}
          description="The pack is removed for everyone who added it, and its link stops working. Stickers already sent stay in chats. This can't be undone."
          confirmLabel="Delete pack"
          destructive
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            del.mutate(confirmDelete);
            setConfirmDelete(null);
          }}
        />
      ) : null}
    </div>
  );
}

function MyPackList({
  type,
  onPreview,
  onRemove,
  onDelete,
}: {
  type: PackType;
  onPreview: (id: string) => void;
  onRemove: (pack: PackSummary, previousOrder: string[]) => void;
  onDelete: (pack: PackSummary) => void;
}) {
  const queryClient = useQueryClient();
  const mine = useQuery({ queryKey: mineKey(type), queryFn: () => getMyPacks(type) });
  const packs = mine.data ?? [];
  const title = type === "sticker" ? "Stickers" : "Animated emoji";

  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderMyPacks(ids),
    onMutate: (ids) => {
      const byId = new Map(packs.map((p) => [p.id, p]));
      queryClient.setQueryData<PackSummary[]>(mineKey(type), ids.map((id) => byId.get(id)!).filter(Boolean));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["packs", "mine"] }),
  });

  function move(i: number, delta: number) {
    const ids = packs.map((p) => p.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids);
  }

  return (
    <ListGroup
      title={title}
      description={
        reorder.isError ? (
          <span role="alert" className="text-danger">
            {errorText(reorder.error, "Couldn't reorder. Try again.")}
          </span>
        ) : packs.length > 1 ? (
          "They appear in your emoji picker in this order."
        ) : undefined
      }
    >
      {mine.isPending ? (
        Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="flex min-h-[64px] items-center gap-3 px-3">
            <Skeleton className="size-11 rounded-[var(--radius-sm)]" />
            <Skeleton className="h-4 w-40" />
          </div>
        ))
      ) : mine.isError ? (
        <div className="flex items-center justify-between gap-3 px-4 py-4">
          <p className="text-[14px] text-danger">Your packs didn&apos;t load.</p>
          <Button size="sm" variant="secondary" onClick={() => mine.refetch()}>
            Try again
          </Button>
        </div>
      ) : packs.length === 0 ? (
        <p className="px-4 py-4 text-[14px] text-muted">No {type === "sticker" ? "sticker" : "animated emoji"} packs yet. Find one above, or tap one someone sends you.</p>
      ) : (
        packs.map((pack, i) => (
          <div key={pack.id} className="flex min-h-[64px] items-center gap-1 py-1.5 pe-2 ps-1">
            <div className="flex shrink-0 flex-col">
              <IconButton size="sm" onClick={() => move(i, -1)} disabled={i === 0 || reorder.isPending} aria-label={`Move ${pack.name} up`}>
                <ArrowUp strokeWidth={1.8} aria-hidden />
              </IconButton>
              <IconButton size="sm" onClick={() => move(i, 1)} disabled={i === packs.length - 1 || reorder.isPending} aria-label={`Move ${pack.name} down`}>
                <ArrowDown strokeWidth={1.8} aria-hidden />
              </IconButton>
            </div>
            <button type="button" onClick={() => onPreview(pack.id)} className="focus-inset flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-sm)] px-1.5 text-start hover:bg-sunken">
              <PackThumb pack={pack} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium text-fg">{pack.name}</span>
                <span className="tabular block truncate text-[13px] text-muted">
                  {pack.itemCount} item{pack.itemCount === 1 ? "" : "s"}
                  {pack.isOwner ? " · Made by you" : ""}
                </span>
              </span>
            </button>
            {pack.isOwner ? (
              <IconButton size="md" onClick={() => onDelete(pack)} aria-label={`Delete ${pack.name}`} title="Delete pack" className="text-danger">
                <Trash2 strokeWidth={1.8} aria-hidden />
              </IconButton>
            ) : null}
            <IconButton
              size="md"
              onClick={() => onRemove(pack, packs.map((p) => p.id))}
              aria-label={`Remove ${pack.name} from my packs`}
              title="Remove from my packs"
            >
              <MinusCircle strokeWidth={1.8} aria-hidden />
            </IconButton>
          </div>
        ))
      )}
    </ListGroup>
  );
}

function FindPacks({ onPreview }: { onPreview: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const q = useDebouncedValue(query.trim(), 300);
  const searching = q.length >= 2;
  const results = useQuery({ queryKey: ["packs", "discover-settings", q], queryFn: () => searchPacks(q), enabled: searching });
  const add = useMutation({
    mutationFn: (pack: PackSummary) => subscribeToPack(pack.id),
    onSuccess: (_r, pack) => {
      queryClient.setQueryData<PackSummary[]>(["packs", "discover-settings", q], (prev) => (prev ?? []).map((p) => (p.id === pack.id ? { ...p, isSubscribed: true } : p)));
      queryClient.invalidateQueries({ queryKey: ["packs", "mine"] });
      queryClient.invalidateQueries({ queryKey: ["packs", "detail"] });
    },
  });

  return (
    <section className="flex flex-col gap-2" aria-label="Find packs">
      <h2 className="px-1 text-[13.5px] font-semibold text-muted">Find packs</h2>
      <label className="flex h-11 items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-panel px-3 text-muted transition-colors focus-within:border-accent hover:border-line-strong">
        <Search className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden />
        <span className="sr-only">Search public packs</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sticker and emoji packs"
          autoComplete="off"
          style={{ outline: "none" }}
          className="h-full w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-muted"
        />
      </label>
      {searching ? (
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel [&>*+*]:border-t [&>*+*]:border-line">
          {results.isPending ? (
            <div className="px-4 py-3">
              <Skeleton className="h-5 w-48" />
            </div>
          ) : results.isError ? (
            <p className="px-4 py-3 text-[14px] text-danger">Search didn&apos;t load. Check your connection and try again.</p>
          ) : (results.data ?? []).length === 0 ? (
            <p className="px-4 py-3 text-[14px] text-muted">No packs match &ldquo;{q}&rdquo;. Try a different word.</p>
          ) : (
            (results.data ?? []).map((pack) => (
              <div key={pack.id} className="flex min-h-[60px] items-center gap-2 py-1.5 pe-2 ps-2">
                <button type="button" onClick={() => onPreview(pack.id)} className="focus-inset flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-sm)] px-1.5 text-start hover:bg-sunken">
                  <PackThumb pack={pack} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-fg">{pack.name}</span>
                    <span className="tabular block truncate text-[13px] text-muted">
                      {pack.type === "sticker" ? "Stickers" : "Animated emoji"} · {pack.itemCount} item{pack.itemCount === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
                {pack.isSubscribed ? (
                  <span className="flex h-9 items-center gap-1 px-3 text-[13.5px] font-semibold text-muted">
                    <Check className="size-4" strokeWidth={2.2} aria-hidden />
                    Added
                  </span>
                ) : (
                  <Button size="sm" loading={add.isPending && add.variables?.id === pack.id} onClick={() => add.mutate(pack)} className={cn("shrink-0")}>
                    Add
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      ) : null}
      {add.isError ? (
        <p role="alert" className="px-1 text-[13px] text-danger">
          {errorText(add.error, "Couldn't add that pack. Try again.")}
        </p>
      ) : null}
    </section>
  );
}
