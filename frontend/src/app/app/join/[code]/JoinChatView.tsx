"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2Off } from "lucide-react";
import { useRouter } from "@/hooks/use-app-router";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { CHANNELS_QUERY_KEY, joinByInvite, previewInvite } from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import { getSocket } from "@/lib/socket";
import { chatPreviewKey } from "@/hooks/use-chat-meta-events";
import { chatKindNoun, memberCountLabel, visibilityLabel } from "@/lib/chat-labels";

/** What an invite link (`/app/join/<code>`) leads to: the chat's card, and
 * Join (or Open, if you're already in it). */
export function JoinChatView({ code }: { code: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [joinError, setJoinError] = useState<string | null>(null);
  const inviteQuery = useQuery({ queryKey: ["invite", code], queryFn: () => previewInvite(code), retry: false });
  const invite = inviteQuery.data;

  const joinMutation = useMutation({
    mutationFn: () => joinByInvite(code),
    onMutate: () => setJoinError(null),
    onSuccess: async ({ channelId }) => {
      // Subscribe this socket to the chat's room so new messages arrive live.
      getSocket()?.emit("join_channel", { channelId });
      queryClient.invalidateQueries({ queryKey: chatPreviewKey(channelId) });
      await queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
      router.replace(`/app/c/${channelId}`);
    },
    onError: (err) =>
      setJoinError(err instanceof ApiError && err.status < 500 ? err.message : "Couldn't join. Check your connection and try again."),
  });

  const noun = chatKindNoun(invite?.type);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title="Invitation" backHref="/app" backLabel="Back to chats" backOnDesktop />
      <PageBody width="sm">
        {inviteQuery.isPending ? (
          <div aria-hidden className="flex flex-col items-center gap-3 pt-6">
            <Skeleton className="size-24 rounded-[var(--radius-lg)]" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-28" />
          </div>
        ) : inviteQuery.isError || !invite ? (
          inviteQuery.error instanceof ApiError && inviteQuery.error.status < 500 ? (
            <EmptyState
              icon={Link2Off}
              title="This invite link doesn't work"
              description="It may have been reset, or the chat no longer exists. Ask someone in the chat for a new link."
              action={{ label: "Back to chats", onClick: () => router.push("/app") }}
            />
          ) : (
            <EmptyState
              icon={Link2Off}
              title="Couldn't open this invitation"
              description="Check your connection, then try again."
              action={{ label: "Try again", onClick: () => inviteQuery.refetch() }}
            />
          )
        ) : (
          <section className="flex flex-col items-center gap-1 pt-6 text-center">
            <Avatar colorId={invite._id} name={invite.name} src={invite.image?.[0]} size={96} shape="square" className="mb-3" />
            <h2 className="max-w-full break-words font-display text-[26px] font-bold leading-tight tracking-[-0.01em] text-fg">{invite.name}</h2>
            <p className="text-[15px] text-muted">
              {visibilityLabel(invite.type, invite.isPublic)} · <span className="tabular">{memberCountLabel(invite.type, invite.memberCount)}</span>
            </p>
            {invite.isPublic && invite.link ? <p className="text-[15px] text-fg-2">@{invite.link}</p> : null}
            {invite.description ? (
              <p dir="auto" className="mt-3 max-w-[420px] whitespace-pre-line break-words text-[15px] leading-relaxed text-fg-2">
                {invite.description}
              </p>
            ) : null}
            <div className="mt-6 flex w-full max-w-[320px] flex-col gap-3">
              {invite.isMember ? (
                <Button size="lg" block onClick={() => router.push(`/app/c/${invite._id}`)}>
                  Open {noun}
                </Button>
              ) : (
                <Button size="lg" block loading={joinMutation.isPending} onClick={() => joinMutation.mutate()}>
                  Join {noun}
                </Button>
              )}
              {invite.isMember ? <p className="text-[13.5px] text-muted">You&apos;re already in this {noun}.</p> : null}
              {joinError ? (
                <p role="alert" className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
                  {joinError}
                </p>
              ) : null}
            </div>
          </section>
        )}
      </PageBody>
    </div>
  );
}
