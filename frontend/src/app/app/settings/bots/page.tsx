"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListGroup, ListItem } from "@/components/ui/List";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonList } from "@/components/ui/Skeleton";
import { getBots } from "@/lib/api/bots";
import { resolvePhotoSrc } from "@/lib/photo-src";

// The dedicated "Bots" surface the brief asks for, alongside the existing
// "Manage packs" entry inside StickerEmojiPicker — this app has exactly one
// bot today (pack-manager), but the directory endpoint itself already
// returns a real list (docs/PACKS_AND_BOTS_FRONTEND_BRIEF.md §2 frames the
// renderer as bot-agnostic on purpose), so this reads from GET /v1/bots
// rather than hardcoding "pack-manager" a second place in the app.
export default function BotsSettingsPage() {
  const botsQuery = useQuery({ queryKey: ["bots"], queryFn: getBots });
  const bots = botsQuery.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title="Bots" backHref="/app/settings" backLabel="Back to settings" backOnDesktop />

      <PageBody>
        {botsQuery.isPending ? (
          <div className="overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel py-1">
            <SkeletonList count={2} />
          </div>
        ) : botsQuery.isError ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-[14px] text-danger">Couldn&apos;t load bots.</p>
            <Button size="sm" variant="secondary" onClick={() => botsQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : bots.length === 0 ? (
          <EmptyState icon={Bot} title="No bots yet" description="Bots that help with sticker packs and more will show up here." />
        ) : (
          <ListGroup title="Available bots" description="Bots add extras like sticker and emoji packs. Open one to see what it can do.">
            {bots.map((bot) => (
              <ListItem
                key={bot.key}
                href={`/app/settings/bots/${bot.key}`}
                leading={
                  resolvePhotoSrc(bot.avatarUrl) ? (
                    // eslint-disable-next-line @next/next/no-img-element -- remote, backend-hosted
                    <img src={resolvePhotoSrc(bot.avatarUrl)!} alt="" className="size-11 shrink-0 rounded-[var(--radius-sm)] object-cover" />
                  ) : (
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-accent-soft text-accent-text">
                      <Bot className="size-5" strokeWidth={1.8} aria-hidden />
                    </span>
                  )
                }
                title={bot.name}
                subtitle={bot.description}
              />
            ))}
          </ListGroup>
        )}
      </PageBody>
    </div>
  );
}
