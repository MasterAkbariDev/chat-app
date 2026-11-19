"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { BotScreenRenderer } from "@/components/packs/BotScreenRenderer";
import { PageHeader } from "@/components/ui/PageHeader";
import { getBots } from "@/lib/api/bots";

// BotScreenRenderer is the same generic, server-described card the sticker
// picker's "Manage packs" uses (docs/PACKS_AND_BOTS_FRONTEND_BRIEF.md §2) —
// hosted here as a real route. The page header supplies "back", so the
// renderer's own × isn't passed an onClose. The bot's display name comes
// from the same ["bots"] directory cache the Bots list already filled.
export default function BotSettingsPage() {
  const { key } = useParams<{ key: string }>();
  const botsQuery = useQuery({ queryKey: ["bots"], queryFn: getBots });
  const bot = botsQuery.data?.find((b) => b.key === key);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title={bot?.name ?? "Bot"} subtitle={bot?.description} backHref="/app/settings/bots" backLabel="Back to bots" backOnDesktop />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <BotScreenRenderer botKey={key} />
      </div>
    </div>
  );
}
