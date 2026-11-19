"use client";

import { useQueries, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserX } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListGroup, ListItem } from "@/components/ui/List";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonList } from "@/components/ui/Skeleton";
import { getUserProfile } from "@/lib/api/contacts";
import { ApiError } from "@/lib/api/client";
import { BLOCKED_QUERY_KEY, getBlockedUserIds, unblockUser } from "@/lib/api/users";

const FOOTNOTE =
  "A blocked person can't call you and won't show up in your search. They can still send a message to an existing chat with you — it just won't arrive live; you'll see it next time you open the chat.";

// GET /users/blocked only returns bare IDs — no bulk/hydrated variant exists
// on this backend (confirmed by reading every controller) — so each id gets
// its own GET /users/by-id/:id, same as one profile lookup would cost
// elsewhere in this app. Fine for a settings list that's rarely long.
export default function BlockedUsersPage() {
  const queryClient = useQueryClient();
  const idsQuery = useQuery({ queryKey: BLOCKED_QUERY_KEY, queryFn: getBlockedUserIds });
  const ids = idsQuery.data ?? [];

  const profileQueries = useQueries({
    queries: ids.map((id) => ({ queryKey: ["users", "profile", id], queryFn: () => getUserProfile(id), enabled: ids.length > 0 })),
  });

  const unblockMutation = useMutation({
    mutationFn: (userId: string) => unblockUser(userId),
    onSuccess: (_data, userId) => {
      queryClient.setQueryData<string[]>(BLOCKED_QUERY_KEY, (prev) => (prev ?? []).filter((id) => id !== userId));
    },
  });

  const loading = idsQuery.isPending || profileQueries.some((q) => q.isPending);
  // A profile that failed to load still gets a row (as "Unknown person") so
  // it can be unblocked — dropping it would leave that block unreachable.
  const rows = ids.map((id, i) => ({ id, profile: profileQueries[i]?.data }));

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title="Blocked users" backHref="/app/settings" backLabel="Back to settings" backOnDesktop />

      <PageBody>
        {loading ? (
          <div className="overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel py-1">
            <SkeletonList count={3} />
          </div>
        ) : idsQuery.isError ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-[14px] text-danger">Couldn&apos;t load your blocked list.</p>
            <Button size="sm" variant="secondary" onClick={() => idsQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <>
            <EmptyState
              icon={UserX}
              title="You haven't blocked anyone"
              description="To block someone, open your chat with them and choose Block from the chat info."
            />
            <p className="px-1 text-center text-[13px] leading-relaxed text-muted">{FOOTNOTE}</p>
          </>
        ) : (
          <ListGroup
            title={`${rows.length} ${rows.length === 1 ? "person" : "people"}`}
            description={
              unblockMutation.isError ? (
                <span role="alert" className="text-danger">
                  {unblockMutation.error instanceof ApiError
                    ? unblockMutation.error.message
                    : "Couldn't unblock them. Check your connection and try again."}
                </span>
              ) : (
                FOOTNOTE
              )
            }
          >
            {rows.map(({ id, profile }) => {
              const name = profile ? [profile.firstName, profile.lastName].filter(Boolean).join(" ") || profile.username : "Unknown person";
              const pending = unblockMutation.isPending && unblockMutation.variables === id;
              return (
                <ListItem
                  key={id}
                  leading={<Avatar colorId={id} name={name} size={44} />}
                  title={name}
                  subtitle={profile ? `@${profile.username}` : "Profile unavailable"}
                  trailing={
                    <Button variant="secondary" size="sm" className="h-10" loading={pending} onClick={() => unblockMutation.mutate(id)} aria-label={`Unblock ${name}`}>
                      Unblock
                    </Button>
                  }
                />
              );
            })}
          </ListGroup>
        )}
      </PageBody>
    </div>
  );
}
