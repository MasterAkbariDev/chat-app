"use client";

import type { PackType } from "@/lib/api/types";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Link2, PackageX, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api/client";
import { copyPackLink, getPack, getPackByLink, subscribeToPack, unsubscribeFromPack } from "@/lib/api/packs";
import { PackImage } from "@/components/packs/PackImage";

export interface PackPreviewSheetProps {
  packId?: string;
  slug?: string;
  onClose: () => void;
  /** Tap an item to send it — only offered when the pack is already in the
   * caller's collection (isSubscribed), matching the brief's rule that the
   * preview sheet's only action for an unowned pack is Add, never "use this
   * item directly." */
  onSendItem?: (packId: string, itemId: string, relativePath: string, extra?: { keywords: string[]; type: PackType }) => void;
  onManage?: (packId: string) => void;
}

// The core interaction the whole packs feature is built around: a pack is
// discovered (search) or shared (link) — either way it opens here. Name,
// item grid, owner, count, and a single Add/Remove button.
export function PackPreviewSheet({ packId, slug, onClose, onSendItem, onManage }: PackPreviewSheetProps) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["packs", "detail", packId ?? slug],
    queryFn: () => (packId ? getPack(packId) : getPackByLink(slug!)),
  });
  const pack = detailQuery.data;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["packs", "mine"] });
    queryClient.invalidateQueries({ queryKey: ["packs", "detail"] });
    queryClient.invalidateQueries({ queryKey: ["packs", "search-items"] });
  };
  const subscribeMutation = useMutation({ mutationFn: () => subscribeToPack(pack!.id), onSuccess: invalidate });
  const unsubscribeMutation = useMutation({ mutationFn: () => unsubscribeFromPack(pack!.id), onSuccess: invalidate });
  const toggling = subscribeMutation.isPending || unsubscribeMutation.isPending;
  const mutationError = subscribeMutation.error ?? unsubscribeMutation.error;
  const canSend = !!pack?.isSubscribed && !!onSendItem;
  const kind = pack?.type === "sticker" ? "sticker" : "animated emoji";
  const collection = pack?.type === "sticker" ? "stickers" : "emoji";
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const footer = pack ? (
    <>
      <Button
        variant="ghost"
        className="max-sm:w-full sm:me-auto"
        onClick={() => {
          void copyPackLink(pack.slug).then((ok) => setCopied(ok));
        }}
      >
        {copied ? <Check className="size-4" strokeWidth={2.2} aria-hidden /> : <Link2 className="size-4" strokeWidth={1.9} aria-hidden />}
        {copied ? "Link copied" : "Copy link"}
      </Button>
      {pack.isOwner && onManage ? (
        <IconButton aria-label="Manage pack" variant="subtle" size="lg" className="rounded-[var(--radius-sm)] max-sm:w-full" onClick={() => onManage(pack.id)}>
          <Settings2 strokeWidth={1.8} aria-hidden />
        </IconButton>
      ) : null}
      {pack.isSubscribed ? (
        <Button variant="secondary" loading={toggling} onClick={() => unsubscribeMutation.mutate()}>
          Remove from my {collection}
        </Button>
      ) : (
        <Button loading={toggling} onClick={() => subscribeMutation.mutate()}>
          Add to my {collection}
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <Dialog
      onClose={onClose}
      size="md"
      title={pack ? pack.name : undefined}
      aria-label={pack ? undefined : "Pack preview"}
      description={
        pack ? (
          <>
            {pack.description ? (
              <span dir="auto" className="block text-start text-fg-2">
                {pack.description}
              </span>
            ) : null}
            <span className="tabular mt-0.5 block text-[13px]">
              {pack.type === "sticker" ? "Sticker pack" : "Animated emoji pack"} · {pack.itemCount} item{pack.itemCount === 1 ? "" : "s"}
              {pack.isOwner ? " · Made by you" : ""}
            </span>
          </>
        ) : undefined
      }
      footer={footer}
    >
      {detailQuery.isPending ? (
        <div role="status" aria-label="Loading pack" className="flex flex-col gap-4 py-1">
          <Skeleton className="h-5 w-1/2" />
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="aspect-square rounded-[var(--radius-sm)]" />
            ))}
          </div>
        </div>
      ) : detailQuery.isError || !pack ? (
        <div className="flex flex-col items-center px-4 py-8 text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
            <PackageX className="size-6" strokeWidth={1.8} aria-hidden />
          </div>
          <div className="text-[16px] font-semibold text-fg">Pack not found</div>
          <p className="mt-1 text-[14px] text-muted">
            {detailQuery.error instanceof ApiError ? detailQuery.error.message : "The link may be wrong, or the pack was deleted."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 pb-1">
          {pack.items.length === 0 ? (
            <p className="py-6 text-center text-[14px] text-muted">This pack doesn&apos;t have any items yet.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
              {pack.items.map((item) => {
                const label = item.keywords.join(", ") || kind;
                const img = (
                  <PackImage thumbPath={item.thumbPath ?? item.relativePath} stillPath={item.stillPath} alt={canSend ? "" : label} className="size-full object-contain" />
                );
                return canSend ? (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSendItem!(pack.id, item.id, item.relativePath, { keywords: item.keywords, type: pack.type })}
                    aria-label={`Send ${label}`}
                    title={label}
                    className="pressable flex aspect-square items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-sunken p-1.5 hover:bg-line"
                  >
                    {img}
                  </button>
                ) : (
                  <div key={item.id} title={label} className="flex aspect-square items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-sunken p-1.5">
                    {img}
                  </div>
                );
              })}
            </div>
          )}
          {pack.isSubscribed ? (
            <p className="flex items-center gap-1.5 text-[13.5px] text-muted">
              <Check className="size-4 text-accent-text" strokeWidth={2.2} aria-hidden />
              Added — it&apos;s in the {kind === "sticker" ? "Stickers" : "Animated"} tab of your emoji picker.
            </p>
          ) : (
            <p className="text-[13.5px] text-muted">Add this pack to use its {kind === "sticker" ? "stickers" : "emoji"} in your chats.</p>
          )}
          {mutationError ? (
            <p role="alert" className="text-[13.5px] text-danger">
              {mutationError instanceof ApiError ? mutationError.message : "Couldn't update your packs. Check your connection and try again."}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
