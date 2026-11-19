"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-app-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Crown,
  MessageSquareOff,
  MessageSquareText,
  MoreHorizontal,
  Search,
  ShieldCheck,
  ShieldMinus,
  ShieldPlus,
  SlidersHorizontal,
  UserPlus,
  UserRound,
  Users,
} from "lucide-react";
import { AddMembersDialog } from "@/components/chat/AddMembersDialog";
import { AdminRightsDialog, canManageAdmin } from "@/components/chat/AdminRightsDialog";
import { MemberPermissionsDialog, exceptionKeys } from "@/components/chat/MemberPermissionsDialog";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { ListGroup } from "@/components/ui/List";
import { Menu, useMenuState, type MenuItem } from "@/components/ui/Menu";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { SkeletonRow } from "@/components/ui/Skeleton";
import {
  CHANNELS_QUERY_KEY,
  banUser,
  getBannedUsers,
  getChannelsMine,
  getMembersForManagement,
  getParticipants,
  muteMember,
  setAdmin,
  unbanUser,
  unmuteMember,
  type MemberForManagement,
  type Participant,
} from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/contexts/auth-context";
import { cn } from "@/lib/cn";
import { memberCountLabel } from "@/lib/chat-labels";
import { chatManagementKey, chatParticipantsKey } from "@/hooks/use-chat-meta-events";
import { useChatPermissionSettings, useChatPermissions } from "@/hooks/use-chat-permissions";
import type { ChatRole, MemberPermissions, PublicUser } from "@/lib/api/types";

const ROLE_LABEL: Record<ChatRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const ROLE_ORDER: Record<ChatRole, number> = { owner: 0, admin: 1, member: 2 };
const BANNED_QUERY_KEY = (channelId: string) => ["chats", channelId, "banned"] as const;
/** Below this many people a filter field is just clutter. */
const FILTER_THRESHOLD = 8;

function displayName(p: { firstName?: string; lastName?: string; username: string }) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username;
}

type ManagedMember = Pick<MemberForManagement, "userId" | "username" | "firstName" | "lastName" | "role" | "adminRights" | "permissions" | "promotedBy">;

/** A member's management row, or a stand-in built from the participant list
 *  while that row is loading. */
function managedOf(p: Participant, row: MemberForManagement | undefined): ManagedMember {
  return {
    userId: p.userId,
    username: p.username,
    firstName: p.firstName ?? "",
    lastName: p.lastName ?? "",
    role: p.role,
    adminRights: row?.adminRights ?? null,
    permissions: row?.permissions ?? null,
    promotedBy: row?.promotedBy ?? null,
  };
}

/** "Restricted" when an exception takes something away, "Exception" when it only adds. */
function exceptionBadge(permissions: Partial<MemberPermissions> | null | undefined): "Restricted" | "Exception" | null {
  const keys = exceptionKeys(permissions);
  if (keys.length === 0) return null;
  return keys.some((k) => permissions?.[k] === false) ? "Restricted" : "Exception";
}

export function MembersPanel({ channelId }: { channelId: string }) {
  const { user } = useAuth();
  const myId = user?._id;
  const queryClient = useQueryClient();
  const [banTarget, setBanTarget] = useState<Participant | null>(null);
  const [banError, setBanError] = useState<string | null>(null);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [adminTarget, setAdminTarget] = useState<ManagedMember | null>(null);
  const [permsTarget, setPermsTarget] = useState<ManagedMember | null>(null);
  const [demoteTarget, setDemoteTarget] = useState<Participant | null>(null);
  const [filter, setFilter] = useState("");
  // Mute/unban fire straight from a menu or button (no dialog to show an
  // error in), so a failure is reported here instead of silently doing nothing.
  const [actionError, setActionError] = useState<string | null>(null);

  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine() });
  const channel = channelsQuery.data?.items.find((c) => c.channelId === channelId);
  // Gate on what I may actually do here, not on my role: admins each have their own rights.
  const my = useChatPermissions(channelId);
  const isGroup = channel?.type === "group";
  const isChannel = channel?.type === "channel";
  const canBan = !!my?.admin.banUsers;
  // Restricting (mute, exceptions) is a group thing; channel subscribers only read.
  const canRestrict = canBan && isGroup;
  const canAddAdmins = !!my?.admin.addAdmins;
  const canAddMembers = !!my?.member.addMembers;

  const participantsQuery = useQuery({
    queryKey: chatParticipantsKey(channelId),
    queryFn: () => getParticipants(channelId),
  });
  const participants = participantsQuery.data ?? [];

  const bannedQuery = useQuery({
    queryKey: BANNED_QUERY_KEY(channelId),
    queryFn: () => getBannedUsers(channelId),
    enabled: canBan,
  });
  const banned = bannedQuery.data?.users ?? [];

  // Only used as a lookup by userId (rights, exceptions, who appointed whom) —
  // it includes past members, so never treat it as the member list.
  const managementQuery = useQuery({
    queryKey: chatManagementKey(channelId),
    queryFn: () => getMembersForManagement(channelId),
    enabled: canBan || canAddAdmins,
  });
  const managementMap = new Map((managementQuery.data ?? []).map((m) => [m.userId, m]));
  const settingsQuery = useChatPermissionSettings(channelId, canRestrict);
  const defaults = settingsQuery.data?.defaultPermissions;

  const banMutation = useMutation({
    mutationFn: (userId: string) => banUser(channelId, userId),
    onSuccess: (_res, userId) => {
      const target = participants.find((p) => p.userId === userId);
      queryClient.setQueryData<Participant[]>(chatParticipantsKey(channelId), (prev) => (prev ?? []).filter((p) => p.userId !== userId));
      if (target) {
        queryClient.setQueryData<{ users: PublicUser[] }>(BANNED_QUERY_KEY(channelId), (prev) => ({
          users: [...(prev?.users ?? []), { _id: target.userId, username: target.username, firstName: target.firstName ?? "", lastName: target.lastName ?? "", avatarUrl: [], bio: "" }],
        }));
      }
      // The chat list's (and info screen's) `memberCount` comes from the
      // channels query, not the participants list patched above.
      queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
      setBanTarget(null);
    },
    onError: (err) => setBanError(err instanceof ApiError ? err.message : "Couldn't remove them. Check your connection and try again."),
  });

  const unbanMutation = useMutation({
    mutationFn: (userId: string) => unbanUser(channelId, userId),
    onMutate: () => setActionError(null),
    onError: (err) => setActionError(err instanceof ApiError ? err.message : "Couldn't unban them. Check your connection and try again."),
    onSuccess: (_res, userId) => {
      queryClient.setQueryData<{ users: PublicUser[] }>(BANNED_QUERY_KEY(channelId), (prev) => ({
        users: (prev?.users ?? []).filter((u) => u._id !== userId),
      }));
    },
  });

  // Quick mute = the "Send messages" exception (the server keeps both in step).
  const muteMutation = useMutation({
    mutationFn: ({ userId, muted }: { userId: string; muted: boolean }) =>
      muted ? muteMember(channelId, userId) : unmuteMember(channelId, userId),
    onMutate: () => setActionError(null),
    onError: (err) => setActionError(err instanceof ApiError ? err.message : "Couldn't change that. Check your connection and try again."),
    onSuccess: (_res, { userId, muted }) => {
      queryClient.setQueryData<MemberForManagement[]>(chatManagementKey(channelId), (prev) =>
        (prev ?? []).map((m) => {
          if (m.userId !== userId) return m;
          const next: Partial<MemberPermissions> = { ...(m.permissions ?? {}) };
          if (muted) next.sendMessages = false;
          else delete next.sendMessages;
          return { ...m, mutedByAdmin: muted, permissions: Object.keys(next).length ? next : null };
        }),
      );
      queryClient.invalidateQueries({ queryKey: chatManagementKey(channelId) });
    },
  });

  const demoteMutation = useMutation({
    mutationFn: (userId: string) => setAdmin(channelId, userId, false),
    onMutate: () => setActionError(null),
    onError: (err) => {
      setDemoteTarget(null);
      setActionError(err instanceof ApiError ? err.message : "Couldn't change their role. Check your connection and try again.");
    },
    onSuccess: (_res, userId) => {
      queryClient.setQueryData<Participant[]>(chatParticipantsKey(channelId), (prev) =>
        (prev ?? []).map((p) => (p.userId === userId ? { ...p, role: "member" } : p)),
      );
      queryClient.invalidateQueries({ queryKey: chatManagementKey(channelId) });
      setDemoteTarget(null);
    },
  });

  const needle = filter.trim().toLowerCase();
  const visible = [...participants]
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
    .filter((p) => !needle || displayName(p).toLowerCase().includes(needle) || p.username.toLowerCase().includes(needle));
  const showFilter = participants.length >= FILTER_THRESHOLD;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader
        title={isChannel ? "Subscribers" : "Members"}
        subtitle={participantsQuery.isSuccess ? memberCountLabel(channel?.type, participants.length) : undefined}
        backHref={`/app/c/${channelId}/info`}
        backLabel="Back to chat info"
        backOnDesktop
        actions={
          canAddMembers ? (
            <Button size="sm" onClick={() => setAddMembersOpen(true)}>
              <UserPlus className="size-[18px]" strokeWidth={2} aria-hidden />
              Add
            </Button>
          ) : null
        }
      />

      <PageBody>
        {showFilter ? (
          <div className="relative">
            <Search className="pointer-events-none absolute start-3.5 top-1/2 size-[18px] -translate-y-1/2 text-muted" strokeWidth={1.8} aria-hidden />
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={isChannel ? "Find a subscriber" : "Find a member"}
              aria-label={isChannel ? "Find a subscriber" : "Find a member"}
              autoComplete="off"
              className="ps-10"
            />
          </div>
        ) : null}

        {actionError ? (
          <p role="alert" className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
            {actionError}
          </p>
        ) : null}

        {participantsQuery.isPending ? (
          <ListGroup title={isChannel ? "Subscribers" : "Members"}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </ListGroup>
        ) : participantsQuery.isError ? (
          <EmptyState icon={Users} title={isChannel ? "Couldn't load subscribers" : "Couldn't load members"} description="Check your connection, then try again." action={{ label: "Try again", onClick: () => participantsQuery.refetch() }} />
        ) : visible.length === 0 ? (
          <p className="px-1 py-6 text-center text-[14px] text-muted">
            No {isChannel ? "subscribers" : "members"} match “{filter.trim()}”.
          </p>
        ) : (
          <ListGroup title={needle ? `${visible.length} of ${participants.length}` : undefined}>
            {visible.map((p) => {
              const isSelf = p.userId === myId;
              const row = managementMap.get(p.userId);
              const managed = managedOf(p, row);
              const isMember = p.role === "member";
              const isMuted = isMember && (row?.mutedByAdmin === true || row?.permissions?.sendMessages === false);
              const manageAdmin = canManageAdmin(my, myId, managed);

              const items: MenuItem[] = [];
              if (!isSelf && p.role !== "owner") {
                if (isMember && canAddAdmins) {
                  items.push({ key: "promote", label: "Make admin…", icon: ShieldPlus, onSelect: () => setAdminTarget(managed) });
                }
                if (p.role === "admin" && manageAdmin) {
                  items.push(
                    { key: "rights", label: "Edit admin rights", icon: ShieldCheck, onSelect: () => setAdminTarget(managed) },
                    { key: "demote", label: "Remove admin", icon: ShieldMinus, onSelect: () => setDemoteTarget(p) },
                  );
                }
                if (isMember && canRestrict) {
                  if (defaults) {
                    items.push({ key: "perms", label: "Permissions…", icon: SlidersHorizontal, onSelect: () => setPermsTarget(managed) });
                  }
                  items.push({
                    key: "mute",
                    label: isMuted ? "Unmute" : "Mute",
                    icon: isMuted ? MessageSquareText : MessageSquareOff,
                    disabled: muteMutation.isPending && muteMutation.variables?.userId === p.userId,
                    onSelect: () => muteMutation.mutate({ userId: p.userId, muted: !isMuted }),
                  });
                }
                // Only the owner can ban an admin (the server checks this too).
                if (canBan && (isMember || my?.role === "owner")) {
                  items.push(
                    { key: "sep", separator: true },
                    {
                      key: "ban",
                      label: "Remove and ban",
                      icon: Ban,
                      danger: true,
                      onSelect: () => {
                        setBanError(null);
                        setBanTarget(p);
                      },
                    },
                  );
                }
              }

              return (
                <MemberRow
                  key={p.userId}
                  participant={p}
                  isSelf={isSelf}
                  isMuted={isMuted}
                  exception={isMember && canRestrict ? exceptionBadge(row?.permissions) : null}
                  actions={items}
                />
              );
            })}
          </ListGroup>
        )}

        {canBan ? (
          <ListGroup title="Banned" description="Banned people can't rejoin until you unban them.">
            {bannedQuery.isPending ? (
              <SkeletonRow />
            ) : bannedQuery.isError ? (
              <div className="px-4 py-4 text-[14px] text-danger">Couldn&apos;t load the banned list. Check your connection and reopen this page.</div>
            ) : banned.length === 0 ? (
              <div className="px-4 py-4 text-[14px] text-muted">No one is banned.</div>
            ) : (
              banned.map((u) => (
                <div key={u._id} className="flex min-h-[64px] items-center gap-3 px-4 py-2.5">
                  <Avatar colorId={u._id} name={displayName(u)} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-fg">{displayName(u)}</div>
                    <div className="truncate text-[13.5px] text-muted">@{u.username}</div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={unbanMutation.isPending && unbanMutation.variables === u._id}
                    onClick={() => unbanMutation.mutate(u._id)}
                    aria-label={`Unban ${displayName(u)}`}
                  >
                    Unban
                  </Button>
                </div>
              ))
            )}
          </ListGroup>
        ) : null}
      </PageBody>

      {banTarget ? (
        <ConfirmDialog
          title={`Remove and ban ${displayName(banTarget)}?`}
          description={
            <>
              They&apos;ll be removed from this chat immediately and can&apos;t rejoin until unbanned.
              {banError ? <span className="mt-2 block text-danger">{banError}</span> : null}
            </>
          }
          confirmLabel="Remove and ban"
          destructive
          pending={banMutation.isPending}
          onConfirm={() => banMutation.mutate(banTarget.userId)}
          onClose={() => setBanTarget(null)}
        />
      ) : null}

      {demoteTarget ? (
        <ConfirmDialog
          title={`Remove ${displayName(demoteTarget)} as admin?`}
          description="They'll stay in the chat as a regular member and lose all admin rights."
          confirmLabel="Remove admin"
          destructive
          pending={demoteMutation.isPending}
          onConfirm={() => demoteMutation.mutate(demoteTarget.userId)}
          onClose={() => setDemoteTarget(null)}
        />
      ) : null}

      {adminTarget && my ? (
        <AdminRightsDialog channelId={channelId} chatType={channel?.type} member={adminTarget} my={my} onClose={() => setAdminTarget(null)} />
      ) : null}

      {permsTarget && defaults ? (
        <MemberPermissionsDialog channelId={channelId} member={permsTarget} defaults={defaults} onClose={() => setPermsTarget(null)} />
      ) : null}

      {addMembersOpen ? (
        <AddMembersDialog
          channelId={channelId}
          existingUserIds={participants.map((p) => p.userId)}
          canShareInvite={!!my?.admin.inviteUsers}
          onClose={() => setAddMembersOpen(false)}
          onAdded={(added) => {
            queryClient.setQueryData<Participant[]>(chatParticipantsKey(channelId), (prev) => [
              ...(prev ?? []),
              ...added.map((u): Participant => ({ userId: u._id, username: u.username, firstName: u.firstName, lastName: u.lastName, role: "member" })),
            ]);
            if (added.length > 0) queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
          }}
        />
      ) : null}
    </div>
  );
}

function RoleBadge({ role }: { role: ChatRole }) {
  if (role === "member") return null;
  const Icon = role === "owner" ? Crown : ShieldCheck;
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-semibold",
        role === "owner" ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent-text",
      )}
    >
      <Icon className="size-3.5" strokeWidth={2} aria-hidden />
      {ROLE_LABEL[role]}
    </span>
  );
}

/** The row's identity is a Link to the profile; the overflow button is its
 * sibling (never nested inside the link). */
function MemberRow({
  participant: p,
  isSelf,
  isMuted,
  exception,
  actions,
}: {
  participant: Participant;
  isSelf: boolean;
  isMuted: boolean;
  exception: "Restricted" | "Exception" | null;
  actions: MenuItem[];
}) {
  const router = useRouter();
  const menu = useMenuState();
  const name = displayName(p);

  const items: MenuItem[] = [{ key: "profile", label: "View profile", icon: UserRound, onSelect: () => router.push(`/app/user/${p.userId}`) }, ...actions];

  const identity = (
    <>
      <Avatar colorId={p.userId} name={name} size={44} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold text-fg">{name}</span>
          {isSelf ? <span className="shrink-0 text-[13.5px] text-muted">(you)</span> : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[13.5px] text-muted">
          <span className="truncate">@{p.username}</span>
          {isMuted ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-warning">
              · <MessageSquareOff className="size-3.5" strokeWidth={2} aria-hidden /> Can&apos;t send
            </span>
          ) : null}
        </span>
      </span>
      {exception ? (
        <span
          className={cn(
            "inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[12px] font-semibold",
            exception === "Restricted" ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent-text",
          )}
        >
          {exception}
        </span>
      ) : null}
      <RoleBadge role={p.role} />
    </>
  );

  return (
    <div className="flex min-h-[64px] items-center gap-1 pe-2">
      {isSelf ? (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5">{identity}</div>
      ) : (
        <Link
          href={`/app/user/${p.userId}`}
          className="focus-inset flex min-w-0 flex-1 items-center gap-3 self-stretch px-4 py-2.5 transition-colors duration-[var(--dur-fast)] hover:bg-sunken"
        >
          {identity}
        </Link>
      )}
      {!isSelf && actions.length > 0 ? (
        <>
          <IconButton
            aria-label={`Options for ${name}`}
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={(e) => menu.openFrom(e.currentTarget)}
          >
            <MoreHorizontal strokeWidth={2} />
          </IconButton>
          {menu.anchor ? <Menu anchor={menu.anchor} aria-label={`Options for ${name}`} items={items} onClose={menu.close} /> : null}
        </>
      ) : null}
    </div>
  );
}
