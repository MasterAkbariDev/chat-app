"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldPlus, SlidersHorizontal } from "lucide-react";
import { AdminRightsDialog, adminRightsSummary, canManageAdmin } from "@/components/chat/AdminRightsDialog";
import {
  MEMBER_PERMISSION_COPY,
  MemberPermissionsDialog,
  NEEDS_SEND,
  RightSwitchRow,
  exceptionKeys,
} from "@/components/chat/MemberPermissionsDialog";
import { Avatar } from "@/components/ui/Avatar";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListGroup, ListItem } from "@/components/ui/List";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonRow } from "@/components/ui/Skeleton";
import {
  CHANNELS_QUERY_KEY,
  chatPermissionsKey,
  getChannelsMine,
  getChatPermissions,
  getMembersForManagement,
  getParticipants,
  setDefaultPermissions,
  type MemberForManagement,
} from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import { MEMBER_PERMISSION_KEYS, type MemberPermissionKey, type MemberPermissions } from "@/lib/api/types";
import { chatManagementKey, chatParticipantsKey } from "@/hooks/use-chat-meta-events";
import { useChatPermissionSettings, useChatPermissions } from "@/hooks/use-chat-permissions";
import { useAuth } from "@/contexts/auth-context";

function personName(p: { firstName?: string; lastName?: string; username: string }) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username;
}

type Settings = Awaited<ReturnType<typeof getChatPermissions>>;

/** Group → Permissions: what every member may do, per-person exceptions, and
 *  the administrators with their rights. Needs the "Ban and restrict" right. */
export function ChatPermissionsPanel({ channelId }: { channelId: string }) {
  const { user } = useAuth();
  const myId = user?._id;
  const queryClient = useQueryClient();
  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine() });
  const channel = channelsQuery.data?.items.find((c) => c.channelId === channelId);
  const my = useChatPermissions(channelId);
  const settingsQuery = useChatPermissionSettings(channelId);
  const defaults = settingsQuery.data?.defaultPermissions;
  const allowed = !!my?.admin.banUsers && channel?.type === "group";

  const participantsQuery = useQuery({
    queryKey: chatParticipantsKey(channelId),
    queryFn: () => getParticipants(channelId),
    enabled: allowed,
  });
  const managementQuery = useQuery({
    queryKey: chatManagementKey(channelId),
    queryFn: () => getMembersForManagement(channelId),
    enabled: allowed,
  });

  const [error, setError] = useState<string | null>(null);
  const [permsTarget, setPermsTarget] = useState<MemberForManagement | null>(null);
  const [adminTarget, setAdminTarget] = useState<MemberForManagement | null>(null);
  const [pickingAdmin, setPickingAdmin] = useState(false);

  // Saved on every switch, shown at once; put back if the server says no.
  const defaultsMutation = useMutation({
    mutationFn: (patch: Partial<MemberPermissions>) => setDefaultPermissions(channelId, patch),
    onMutate: async (patch) => {
      setError(null);
      await queryClient.cancelQueries({ queryKey: chatPermissionsKey(channelId) });
      const previous = queryClient.getQueryData<Settings>(chatPermissionsKey(channelId));
      queryClient.setQueryData<Settings>(chatPermissionsKey(channelId), (prev) =>
        prev ? { ...prev, defaultPermissions: { ...prev.defaultPermissions, ...patch } } : prev,
      );
      return { previous };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(chatPermissionsKey(channelId), ctx.previous);
      setError(err instanceof ApiError && err.status < 500 ? err.message : "Couldn't save that. Check your connection and try again.");
    },
    onSuccess: (res) => {
      queryClient.setQueryData<Settings>(chatPermissionsKey(channelId), (prev) => (prev ? { ...prev, defaultPermissions: res.defaultPermissions } : prev));
    },
  });

  // Current members only: the management list also holds people who left.
  const current = new Set((participantsQuery.data ?? []).map((p) => p.userId));
  const rows = (managementQuery.data ?? []).filter((m) => current.has(m.userId) && !m.isBanned);
  const exceptions = rows.filter((m) => m.role === "member" && exceptionKeys(m.permissions).length > 0);
  const admins = rows.filter((m) => m.role === "owner" || m.role === "admin").sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : 0));
  const plainMembers = rows.filter((m) => m.role === "member");

  const loading = channelsQuery.isPending || (!!channel && !my) || settingsQuery.isPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader title="Permissions" subtitle={channel?.name} backHref={`/app/c/${channelId}/info`} backLabel="Back to group info" backOnDesktop />
      <PageBody>
        {loading ? (
          <ListGroup title="What members can do">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </ListGroup>
        ) : !allowed || !defaults ? (
          <EmptyState
            icon={SlidersHorizontal}
            title="You can't change permissions here"
            description="Only the owner and admins who can ban and restrict members can set what members may do in a group."
          />
        ) : (
          <>
            <ListGroup title="What members can do" description="Applies to everyone who isn't an admin. Changes save right away.">
              {MEMBER_PERMISSION_KEYS.map((k: MemberPermissionKey) => {
                const blocked = NEEDS_SEND.has(k) && !defaults.sendMessages;
                return (
                  <RightSwitchRow
                    key={k}
                    label={MEMBER_PERMISSION_COPY[k].label}
                    hint={blocked ? "Needs “Send messages”" : MEMBER_PERMISSION_COPY[k].hint}
                    checked={blocked ? false : defaults[k]}
                    disabled={blocked}
                    onChange={(v) => defaultsMutation.mutate({ [k]: v })}
                  />
                );
              })}
            </ListGroup>
            {error ? (
              <p role="alert" className="-mt-4 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
                {error}
              </p>
            ) : null}

            <ListGroup title="Exceptions" description="People who can do more, or less, than everyone else. Set one from a member's Permissions… option.">
              {managementQuery.isPending || participantsQuery.isPending ? (
                <SkeletonRow />
              ) : exceptions.length === 0 ? (
                <div className="px-4 py-4 text-[14px] text-muted">No exceptions. Everyone follows the settings above.</div>
              ) : (
                exceptions.map((m) => {
                  const n = exceptionKeys(m.permissions).length;
                  return (
                    <ListItem
                      key={m.userId}
                      leading={<Avatar colorId={m.userId} name={personName(m)} size={40} />}
                      title={personName(m)}
                      subtitle={n === 1 ? "1 exception" : `${n} exceptions`}
                      chevron
                      onClick={() => setPermsTarget(m)}
                    />
                  );
                })
              )}
            </ListGroup>

            <ListGroup title="Administrators">
              {managementQuery.isPending || participantsQuery.isPending ? (
                <SkeletonRow />
              ) : (
                admins.map((m) => {
                  const editable = m.role === "admin" && canManageAdmin(my, myId, m);
                  return (
                    <ListItem
                      key={m.userId}
                      leading={<Avatar colorId={m.userId} name={personName(m)} size={40} />}
                      title={m.userId === myId ? `${personName(m)} (you)` : personName(m)}
                      subtitle={m.role === "owner" ? "Owner · all rights" : adminRightsSummary(m.adminRights, channel?.type)}
                      trailing={m.role === "owner" ? undefined : <ShieldCheck className="size-[18px] text-accent-text" strokeWidth={2} aria-hidden />}
                      chevron={editable}
                      onClick={editable ? () => setAdminTarget(m) : undefined}
                    />
                  );
                })
              )}
              {my?.admin.addAdmins ? <ListItem icon={ShieldPlus} title="Add admin" onClick={() => setPickingAdmin(true)} /> : null}
            </ListGroup>
          </>
        )}
      </PageBody>

      {permsTarget && defaults ? (
        <MemberPermissionsDialog channelId={channelId} member={permsTarget} defaults={defaults} onClose={() => setPermsTarget(null)} />
      ) : null}

      {adminTarget && my ? (
        <AdminRightsDialog channelId={channelId} chatType={channel?.type} member={adminTarget} my={my} onClose={() => setAdminTarget(null)} />
      ) : null}

      {pickingAdmin ? (
        <Dialog onClose={() => setPickingAdmin(false)} size="md" title="Add admin" description="Choose a member to make an admin." bodyClassName="px-0 py-0">
          {plainMembers.length === 0 ? (
            <p className="px-5 py-6 text-center text-[14px] text-muted">Everyone here is already an admin.</p>
          ) : (
            <div className="divide-y divide-line border-y border-line">
              {plainMembers.map((m) => (
                <ListItem
                  key={m.userId}
                  leading={<Avatar colorId={m.userId} name={personName(m)} size={40} />}
                  title={personName(m)}
                  subtitle={`@${m.username}`}
                  onClick={() => {
                    setPickingAdmin(false);
                    setAdminTarget(m);
                  }}
                />
              ))}
            </div>
          )}
        </Dialog>
      ) : null}
    </div>
  );
}
