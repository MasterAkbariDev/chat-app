"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Link2, PackageX } from "lucide-react";
import { useRouter } from "@/hooks/use-app-router";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { PackImage } from "@/components/packs/PackImage";
import { ApiError } from "@/lib/api/client";
import { copyPackLink, getPackByLink, subscribeToPack, unsubscribeFromPack } from "@/lib/api/packs";

/** What a pack link (`/app/addpack/<slug>`) leads to: the pack's items, and
 * Add (or Added, with a way to remove it again). Signed-out visitors are sent
 * to sign in and brought back here (AppShell's resume path). */
export function AddPackView({ slug }: { slug: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const packQuery = useQuery({ queryKey: ["packs", "detail", slug], queryFn: () => getPackByLink(slug), retry: false });
  const pack = packQuery.data;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["packs", "mine"] });
    queryClient.invalidateQueries({ queryKey: ["packs", "detail"] });
    queryClient.invalidateQueries({ queryKey: ["packs", "search-items"] });
  };
  const add = useMutation({ mutationFn: () => subscribeToPack(pack!.id), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => unsubscribeFromPack(pack!.id), onSuccess: invalidate });
  const error = add.error ?? remove.error;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const kind = pack?.type === "sticker" ? "sticker" : "animated emoji";
  const added = !!pack?.isSubscribed;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title={pack?.type === "sticker" ? "Sticker pack" : pack ? "Emoji pack" : "Pack"} backHref="/app" backLabel="Back to chats" backOnDesktop />
      <PageBody width="sm">
        {packQuery.isPending ? (
          <div aria-hidden className="flex flex-col items-center gap-3 pt-6">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-32" />
            <div className="mt-4 grid w-full grid-cols-4 gap-2 sm:grid-cols-5">
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} className="aspect-square rounded-[var(--radius-sm)]" />
              ))}
            </div>
          </div>
        ) : packQuery.isError || !pack ? (
          packQuery.error instanceof ApiError && packQuery.error.status < 500 ? (
            <EmptyState
              icon={PackageX}
              title="This pack link doesn't work"
              description="The pack may have been deleted, or the link was copied wrong."
              action={{ label: "Back to chats", onClick: () => router.push("/app") }}
            />
          ) : (
            <EmptyState
              icon={PackageX}
              title="Couldn't open this pack"
              description="Check your connection, then try again."
              action={{ label: "Try again", onClick: () => packQuery.refetch() }}
            />
          )
        ) : (
          <section className="flex flex-col gap-5 pt-2">
            <div className="flex flex-col items-center gap-1 text-center">
              <h2 className="max-w-full break-words font-display text-[26px] font-bold leading-tight tracking-[-0.01em] text-fg">{pack.name}</h2>
              <p className="tabular text-[15px] text-muted">
                {pack.type === "sticker" ? "Sticker pack" : "Animated emoji pack"} · {pack.itemCount} item{pack.itemCount === 1 ? "" : "s"}
                {pack.isOwner ? " · Made by you" : ""}
              </p>
              {pack.description ? (
                <p className="mt-2 max-w-[420px] whitespace-pre-line break-words text-[14.5px] leading-relaxed text-fg-2">{pack.description}</p>
              ) : null}
            </div>

            {pack.items.length === 0 ? (
              <p className="py-6 text-center text-[14px] text-muted">This pack doesn&apos;t have any items yet.</p>
            ) : (
              <ul className={pack.type === "sticker" ? "grid grid-cols-4 gap-2 sm:grid-cols-5" : "grid grid-cols-6 gap-1.5 sm:grid-cols-7"} aria-label={`${pack.name} items`}>
                {pack.items.map((item) => (
                  <li key={item.id} className="flex aspect-square items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-sunken p-1.5">
                    <PackImage
                      thumbPath={item.thumbPath ?? item.relativePath}
                      stillPath={item.stillPath}
                      alt={item.keywords.join(", ") || kind}
                      className="size-full object-contain"
                    />
                  </li>
                ))}
              </ul>
            )}

            <div className="mx-auto flex w-full max-w-[320px] flex-col gap-3">
              {added ? (
                <>
                  <Button size="lg" block variant="secondary" disabled aria-label="Added to your packs">
                    <Check className="size-[18px]" strokeWidth={2.2} aria-hidden />
                    Added
                  </Button>
                  <p className="text-center text-[13.5px] text-muted">
                    Find it in the {pack.type === "sticker" ? "Stickers" : "Animated"} tab of the emoji picker.{" "}
                    <button
                      type="button"
                      onClick={() => remove.mutate()}
                      disabled={remove.isPending}
                      className="font-semibold text-accent-text underline-offset-2 hover:underline disabled:opacity-60"
                    >
                      {remove.isPending ? "Removing…" : "Remove"}
                    </button>
                  </p>
                </>
              ) : (
                <Button size="lg" block loading={add.isPending} onClick={() => add.mutate()}>
                  Add pack
                </Button>
              )}
              <Button
                variant="ghost"
                block
                onClick={() => {
                  void copyPackLink(pack.slug).then((ok) => setCopied(ok));
                }}
              >
                {copied ? <Check className="size-4" strokeWidth={2.2} aria-hidden /> : <Link2 className="size-4" strokeWidth={1.9} aria-hidden />}
                {copied ? "Link copied" : "Copy link"}
              </Button>
              <span role="status" className="sr-only">
                {copied ? "Link copied" : ""}
              </span>
              {error ? (
                <p role="alert" className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
                  {error instanceof ApiError ? error.message : "Couldn't update your packs. Check your connection and try again."}
                </p>
              ) : null}
            </div>
          </section>
        )}
      </PageBody>
    </div>
  );
}
