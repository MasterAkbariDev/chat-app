"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-app-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  Check,
  Copy,
  Crown,
  DoorOpen,
  Flag,
  ImageIcon,
  Lock,
  Pencil,
  Phone,
  Pin,
  RotateCcw,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Users,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { EditChatDialog } from "@/components/chat/EditChatDialog";
import { useChatPhoto } from "@/components/chat/ConversationRow";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ListGroup, ListItem } from "@/components/ui/List";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton, SkeletonRow } from "@/components/ui/Skeleton";
import { TagInput } from "@/components/ui/TagInput";
import {
  CHANNELS_QUERY_KEY,
  deleteChat,
  getChannelsMine,
  getChatPreview,
  getInviteCode,
  getParticipants,
  inviteLink,
  leaveChat,
  muteChat,
  resetInviteCode,
  setChatTags,
  subscribeToChannel,
  unmuteChat,
} from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import { getSocket } from "@/lib/socket";
import { chatParticipantsKey, chatPreviewKey, wasChatDeleted } from "@/hooks/use-chat-meta-events";
import { useChatPermissions } from "@/hooks/use-chat-permissions";
import { chatKindNoun, memberCountLabel, visibilityLabel } from "@/lib/chat-labels";
import { getPinnedMessages } from "@/lib/api/messages";
import { channelDisplayName, type ChannelSummary, type ChatRole } from "@/lib/api/types";
import { BLOCKED_QUERY_KEY, blockUser, getBlockedUserIds, unblockUser } from "@/lib/api/users";
import { ReportDialog } from "@/components/chat/ReportDialog";
import { UserProfilePanel } from "@/components/chat/UserProfilePanel";
import { SharedMediaBrowser } from "@/components/chat/SharedMediaBrowser";
import { useCall } from "@/contexts/call-context";
import { useAuth } from "@/contexts/auth-context";
import { usePresence } from "@/contexts/presence-context";
import { cn } from "@/lib/cn";

/** How many members the info screen previews before "See all". */
const MEMBER_PREVIEW = 5;
const ROLE_ORDER: Record<ChatRole, number> = { owner: 0, admin: 1, member: 2 };

function personName(p: { firstName?: string; lastName?: string; username: string }) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username;
}

/**
 * `/app/c/<id>/info`. A DM's info is the other person's profile — the same
 * page as `/app/user/<id>` (photo hero, actions, shared media) — so private
 * chats hand off to `UserProfilePanel`; groups, channels and Saved Messages
 * keep their own screen below.
 */
export function ChatInfoPanel({ channelId }: { channelId: string }) {
  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine() });
  const channel = channelsQuery.data?.items.find((c) => c.channelId === channelId);
  if (channel?.type === "private" && channel.otherUser) {
    return <UserProfilePanel userId={channel.otherUser._id} channelId={channelId} />;
  }
  if (channelsQuery.isPending) {
    // Don't flash the group layout while we find out which kind of chat this is.
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-canvas">
        <PageHeader title="Info" backHref={`/app/c/${channelId}`} backLabel="Back to conversation" backOnDesktop />
        <div aria-hidden className="flex flex-col items-center gap-3 pt-6">
          <Skeleton className="size-[120px] rounded-full" />
          <Skeleton className="mt-2 h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }
  return <GroupInfoPanel channelId={channelId} />;
}

/** Group, channel and Saved Messages info (and a public chat you're previewing). */
function GroupInfoPanel({ channelId }: { channelId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { startCall } = useCall();
  const { user: me } = useAuth();
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [confirmingBlock, setConfirmingBlock] = useState(false);
  const [mutePending, setMutePending] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine() });
  const channel = channelsQuery.data?.items.find((c) => c.channelId === channelId);
  // Not in your chat list: a public chat you're previewing (or one past the
  // list's first page — then `isMember`).
  const previewQuery = useQuery({
    queryKey: chatPreviewKey(channelId),
    queryFn: () => getChatPreview(channelId),
    enabled: channelsQuery.isSuccess && !channel,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
  const preview = channel ? undefined : previewQuery.data;
  const isPreviewOnly = !!preview && !preview.isMember;
  const participantsQuery = useQuery({
    queryKey: chatParticipantsKey(channelId),
    queryFn: () => getParticipants(channelId),
    enabled: !!channel || !!preview?.isMember,
  });
  const pinnedQuery = useQuery({
    queryKey: ["messages", "pinned", channelId],
    queryFn: () => getPinnedMessages(channelId),
    enabled: !isPreviewOnly,
  });
  const cachedPhoto = useChatPhoto(channelId);

  const title = channel ? channelDisplayName(channel) : (preview?.name ?? "…");
  const chatType = channel?.type ?? preview?.type;
  const myRole = channel?.myRole ?? preview?.myRole ?? null;
  const isPublic = channel?.isPublic ?? preview?.isPublic ?? false;
  const publicHandle = channel?.link ?? preview?.link ?? null;
  const description = channel?.description ?? preview?.description ?? null;
  const photo = channel ? cachedPhoto : (preview?.image?.[0] ?? null);
  const isGroupLike = chatType === "group" || chatType === "channel";
  const participants = participantsQuery.data ?? [];
  const muted = channel?.isMuted ?? false;
  const isOwner = myRole === "owner";
  const isAdmin = myRole === "admin";
  // Gate on my effective rights here (each admin has their own; members may
  // be allowed some things too), not on my role.
  const my = useChatPermissions(channelId);
  const isMemberHere = !!channel || !!preview?.isMember;
  const canEditInfo = isGroupLike && isMemberHere && !!my?.member.changeInfo;
  const canInvite = isGroupLike && isMemberHere && !!my?.admin.inviteUsers;
  const canSetPermissions = chatType === "group" && isMemberHere && !!my?.admin.banUsers;
  const canManageMembers = !!my && (my.admin.banUsers || my.admin.addAdmins || my.member.addMembers);
  const canDeleteChat = !!channel && isGroupLike && !!my?.canDeleteChat;
  const isPrivate = channel?.type === "private";
  const kindLabel = channel?.type === "channel" ? "channel" : channel?.type === "group" ? "group" : "chat";
  // Leaving your own Saved Messages doesn't make product sense (there's
  // nowhere to "rejoin" it from) — the backend doesn't special-case it in
  // `unsubscribe` (confirmed by reading chat.service.ts), so this is a
  // client-side guard, not something the server already prevents.
  const canLeave = channel?.type !== "saved_messages";
  // Tags exist to feed folder `includeTags` filters (see Chat folders in
  // Settings) — the backend itself doesn't restrict `POST .../tags` to
  // non-private chats, only to admin/owner, but a DM has no real notion of
  // "the group's tags" product-side, so this is a client-side scope choice.
  const canEditTags = channel?.type !== "private" && (isOwner || isAdmin);
  const otherUserId = channel?.type === "private" ? channel.otherUser?._id : undefined;
  const blockedQuery = useQuery({ queryKey: BLOCKED_QUERY_KEY, queryFn: getBlockedUserIds, enabled: !!otherUserId });
  const isBlocked = !!otherUserId && (blockedQuery.data ?? []).includes(otherUserId);
  // Already tracked by the conversation header for this DM, so this reads
  // the shared presence cache rather than adding a fetch.
  const presence = usePresence(otherUserId);

  function toggleMute() {
    setMutePending(true);
    const call = muted ? unmuteChat(channelId) : muteChat(channelId);
    call
      .then(() => queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY }))
      .catch(() => {})
      .finally(() => setMutePending(false));
  }

  // Unblocking fires immediately (reversible, low-stakes); blocking goes
  // through the confirm dialog below since it's the more consequential
  // direction. Patches the cached id list directly — GET /users/blocked
  // has no delta/websocket event of its own to react to instead.
  const blockMutation = useMutation({
    mutationFn: () => (isBlocked ? unblockUser(otherUserId!) : blockUser(otherUserId!)),
    onSuccess: () => {
      queryClient.setQueryData<string[]>(BLOCKED_QUERY_KEY, (prev) => {
        const list = prev ?? [];
        return isBlocked ? list.filter((id) => id !== otherUserId) : [...list, otherUserId!];
      });
      setConfirmingBlock(false);
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => leaveChat(channelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
      router.push("/app");
    },
    onError: () => setLeaveError("Couldn't leave. Check your connection and try again."),
  });

  // Full-replace endpoint — always send the complete desired tag list.
  // Patches the cached ChannelSummary directly from the response instead of
  // invalidating, since the endpoint's own response already has the
  // up-to-date tags and a refetch would just re-fetch the same thing.
  const tagsMutation = useMutation({
    mutationFn: (tags: string[]) => setChatTags(channelId, tags),
    onSuccess: (updated) => {
      queryClient.setQueryData<{ items: ChannelSummary[]; nextCursor: string | null } | undefined>(
        CHANNELS_QUERY_KEY,
        (page) =>
          page
            ? { ...page, items: page.items.map((c) => (c.channelId === channelId ? { ...c, tags: updated.tags ?? [] } : c)) }
            : page,
      );
    },
  });

  // Owner/admin: the invite link (works for private chats too).
  const inviteQuery = useQuery({
    queryKey: ["chats", channelId, "invite"],
    queryFn: () => getInviteCode(channelId),
    enabled: canInvite,
  });
  const resetMutation = useMutation({
    mutationFn: () => resetInviteCode(channelId),
    onSuccess: (data) => {
      queryClient.setQueryData(["chats", channelId, "invite"], data);
      setConfirmingReset(false);
    },
  });

  // Owner only. Everyone else in it gets `chat_deleted` and is taken out of it.
  const deleteMutation = useMutation({
    mutationFn: () => deleteChat(channelId),
    onSuccess: () => {
      // Leave first, so this screen doesn't refetch a chat that's gone.
      setConfirmingDelete(false);
      router.push("/app");
      queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    },
  });

  const joinMutation = useMutation({
    mutationFn: () => subscribeToChannel(channelId),
    onSuccess: async () => {
      getSocket()?.emit("join_channel", { channelId });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: chatPreviewKey(channelId) }),
      ]);
    },
  });

  const memberCount = channel?.memberCount ?? preview?.memberCount ?? participants.length;
  const subtitle = !channel
    ? preview
      ? `${visibilityLabel(preview.type, preview.isPublic)} · ${memberCountLabel(preview.type, preview.memberCount)}`
      : ""
    : isPrivate
      ? presence?.isOnline
        ? "Online"
        : channel.otherUser
          ? `@${channel.otherUser.username}`
          : ""
      : channel.type === "saved_messages"
        ? "Only you can see this"
        : `${visibilityLabel(channel.type, isPublic)} · ${memberCountLabel(channel.type, memberCount)}`;
  const pinnedCount = (pinnedQuery.data ?? []).length;
  // Per-chat wallpapers 400 for a channel server-side (assertChatMember
  // in wallpaper.service.ts only allows private/group) — hidden here
  // rather than shown and failing on tap.
  const canWallpaper = channel?.type === "private" || channel?.type === "group";
  const canCall = channel?.type !== "saved_messages";
  const pageTitle = isPrivate ? "Contact info" : chatType === "channel" ? "Channel info" : chatType === "group" ? "Group info" : "Chat info";
  const notAllowed = !channel && previewQuery.error instanceof ApiError && previewQuery.error.status < 500;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader
        title={pageTitle}
        backHref={`/app/c/${channelId}`}
        backLabel="Back to conversation"
        backOnDesktop
        actions={
          canEditInfo ? (
            <Button size="sm" variant="secondary" onClick={() => setEditOpen(true)} aria-label={`Edit ${chatKindNoun(chatType)}`}>
              <Pencil className="size-4" strokeWidth={2} aria-hidden />
              Edit
            </Button>
          ) : null
        }
      />

      <PageBody
        footer={
          // Shared media of a chat you're in (and of Saved Messages): rest of the page, tabs stuck under the header.
          channel && !notAllowed ? <SharedMediaBrowser channelId={channelId} /> : undefined
        }
      >
        {notAllowed ? (
          wasChatDeleted(channelId) ? (
            <EmptyState icon={Trash2} title="This chat no longer exists" description="It was deleted by its owner." />
          ) : (
            <EmptyState icon={Lock} title="This chat is private" description="Ask someone in it for an invite link." />
          )
        ) : null}

        {/* Hero */}
        {notAllowed ? null : channelsQuery.isPending || (!channel && previewQuery.isPending) ? (
          <div aria-hidden className="flex flex-col items-center gap-3 pt-2">
            <Skeleton className="size-24 rounded-full" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-28" />
          </div>
        ) : (
          <section className="flex flex-col items-center gap-1 pt-2 text-center">
            <Avatar
              colorId={channelId}
              name={title}
              src={photo}
              size={96}
              shape={isPrivate ? "circle" : "square"}
              presence={isPrivate && presence?.isOnline ? "online" : "none"}
              className="mb-3"
            />
            <h2 className="max-w-full break-words font-display text-[26px] font-bold leading-tight tracking-[-0.01em] text-fg">{title}</h2>
            {subtitle ? <p className={cn("text-[15px]", presence?.isOnline && isPrivate ? "text-success" : "text-muted")}>{subtitle}</p> : null}
            {isGroupLike && isPublic && publicHandle ? <p className="text-[15px] text-fg-2">@{publicHandle}</p> : null}
            {isGroupLike && description ? (
              <p dir="auto" className="mt-3 max-w-[480px] whitespace-pre-line break-words text-[15px] leading-relaxed text-fg-2">
                {description}
              </p>
            ) : null}
            {isPreviewOnly ? (
              <div className="mt-5 flex w-full max-w-[320px] flex-col gap-2">
                <Button size="lg" block loading={joinMutation.isPending} onClick={() => joinMutation.mutate()}>
                  Join {chatKindNoun(chatType)}
                </Button>
                {joinMutation.isError ? (
                  <p role="alert" className="text-[13.5px] text-danger">
                    {joinMutation.error instanceof ApiError && joinMutation.error.status < 500
                      ? joinMutation.error.message
                      : "Couldn't join. Check your connection and try again."}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        )}

        {/* Quick actions */}
        {channel ? (
          <div className="grid auto-cols-fr grid-flow-col gap-2">
            {canCall ? (
              <QuickAction icon={Phone} label="Call" onClick={() => startCall(channelId, title, channel.type === "private")} />
            ) : null}
            <QuickAction
              icon={muted ? BellOff : Bell}
              label={muted ? "Unmute" : "Mute"}
              active={muted}
              disabled={mutePending}
              onClick={toggleMute}
            />
            {canWallpaper ? <QuickAction icon={ImageIcon} label="Wallpaper" href={`/app/settings/wallpaper?chat=${channelId}`} /> : null}
          </div>
        ) : null}

        {/* Links */}
        {isGroupLike && isPublic && !notAllowed && (channel || preview) ? (
          <ListGroup title="Public link" description={`Anyone can find this ${chatKindNoun(chatType)} in search and open it with this link.`}>
            <ShareableLink url={chatPublicUrl(channelId)} display={publicHandle ? `@${publicHandle}` : undefined} shareTitle={title} />
          </ListGroup>
        ) : null}
        {canInvite ? (
          <ListGroup
            title="Invite link"
            description={`Anyone with this link can join${isPublic ? "" : `, even though the ${chatKindNoun(chatType)} is private`}. Reset it to stop an old link from working.`}
          >
            {inviteQuery.isPending ? (
              <SkeletonRow />
            ) : inviteQuery.isError || !inviteQuery.data ? (
              <div className="px-4 py-4 text-[14px] text-danger">Couldn&apos;t load the invite link. Check your connection and reopen this page.</div>
            ) : (
              <ShareableLink
                url={inviteLink(inviteQuery.data.inviteCode)}
                shareTitle={title}
                onReset={() => {
                  resetMutation.reset();
                  setConfirmingReset(true);
                }}
              />
            )}
          </ListGroup>
        ) : null}

        {/* People */}
        {isPrivate && otherUserId ? (
          <ListGroup>
            <ListItem icon={UserRound} title="View profile" subtitle="Bio, contact details" href={`/app/user/${otherUserId}`} />
          </ListGroup>
        ) : channel && channel.type !== "saved_messages" ? (
          <ListGroup title={participantsQuery.isSuccess ? memberCountLabel(chatType, participants.length) : chatType === "channel" ? "Subscribers" : "Members"}>
            {participantsQuery.isPending ? (
              <>
                <SkeletonRow />
                <SkeletonRow />
              </>
            ) : participantsQuery.isError ? (
              <div className="px-4 py-4 text-[14px] text-danger">Couldn&apos;t load members. Check your connection and reopen this page.</div>
            ) : (
              [...participants].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]).slice(0, MEMBER_PREVIEW).map((p) => {
                const name = personName(p);
                const isSelf = p.userId === me?._id;
                return (
                  <ListItem
                    key={p.userId}
                    leading={<Avatar colorId={p.userId} name={name} size={40} />}
                    title={isSelf ? `${name} (you)` : name}
                    subtitle={`@${p.username}`}
                    trailing={<RoleBadge role={p.role} />}
                    href={isSelf ? undefined : `/app/user/${p.userId}`}
                  />
                );
              })
            )}
            <ListItem
              icon={Users}
              title={canManageMembers ? "See all and manage" : chatType === "channel" ? "See all subscribers" : "See all members"}
              href={`/app/c/${channelId}/members`}
            />
          </ListGroup>
        ) : null}

        {canSetPermissions ? (
          <ListGroup>
            <ListItem
              icon={SlidersHorizontal}
              title="Permissions"
              subtitle="What members can do, exceptions and admins"
              href={`/app/c/${channelId}/permissions`}
            />
          </ListGroup>
        ) : null}

        {/* Content & organisation */}
        {channel ? (
          <ListGroup
            title="In this chat"
            description={canEditTags ? "Tags sort this chat into folders (Settings → Chat folders). Press Enter or comma to add one." : undefined}
          >
            <ListItem
              icon={Pin}
              title="Pinned messages"
              trailing={<span className="tabular">{pinnedQuery.isPending ? "…" : pinnedCount}</span>}
            />
            {canEditTags ? (
              <div className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span id={`tags-${channelId}`} className="text-[15px] font-medium text-fg">
                    Tags
                  </span>
                  {tagsMutation.isPending ? <span className="text-[12.5px] text-muted">Saving…</span> : null}
                  {tagsMutation.isError ? <span className="text-[12.5px] text-danger">Didn&apos;t save — try again</span> : null}
                </div>
                <div aria-labelledby={`tags-${channelId}`} role="group">
                  <TagInput aria-label="Chat tags" tags={channel.tags ?? []} onChange={(tags) => tagsMutation.mutate(tags)} placeholder="Add a tag…" />
                </div>
              </div>
            ) : null}
          </ListGroup>
        ) : null}

        {/* Danger zone */}
        {channel && channel.type !== "saved_messages" ? (
          <ListGroup description={blockMutation.isError ? <span className="text-danger">That didn&apos;t go through. Check your connection and try again.</span> : undefined}>
            {otherUserId ? (
              <ListItem
                icon={UserX}
                title={isBlocked ? `Unblock ${title}` : `Block ${title}`}
                subtitle={isBlocked ? "They can call you and find you in search again" : undefined}
                danger={!isBlocked}
                // Until the blocked list loads we don't know which way this toggles.
                disabled={blockMutation.isPending || blockedQuery.isPending}
                onClick={() => (isBlocked ? blockMutation.mutate() : setConfirmingBlock(true))}
                trailing={blockMutation.isPending && isBlocked ? <span className="text-[13px]">Unblocking…</span> : undefined}
              />
            ) : null}
            <ListItem icon={Flag} title={`Report ${isPrivate ? title : `this ${kindLabel}`}`} danger onClick={() => setReportOpen(true)} />
            {canLeave ? (
              <ListItem
                icon={DoorOpen}
                title={isPrivate ? "Leave chat" : channel.type === "channel" ? "Leave channel" : "Leave group"}
                danger
                onClick={() => {
                  setLeaveError(null);
                  setConfirmingLeave(true);
                }}
              />
            ) : null}
            {canDeleteChat ? (
              <ListItem
                icon={Trash2}
                title={channel.type === "channel" ? "Delete channel" : "Delete group"}
                subtitle="For everyone, with all its messages"
                danger
                onClick={() => {
                  deleteMutation.reset();
                  setConfirmingDelete(true);
                }}
              />
            ) : null}
          </ListGroup>
        ) : null}
      </PageBody>

      {confirmingBlock ? (
        <ConfirmDialog
          title={`Block ${title}?`}
          description="They won't be able to call you or find you in search. A message they send to this chat still reaches you eventually — just not live — so this isn't a way to stop them from messaging you entirely."
          confirmLabel={`Block ${title}`}
          destructive
          pending={blockMutation.isPending}
          onConfirm={() => blockMutation.mutate()}
          onClose={() => setConfirmingBlock(false)}
        />
      ) : null}

      {canLeave && confirmingLeave ? (
        <ConfirmDialog
          title={isPrivate ? "Leave this chat?" : `Leave ${title}?`}
          description={
            <>
              {isPrivate
                ? "You can reopen it later, but you won't see anything sent while you were away."
                : isPublic
                  ? "You can rejoin from search any time, but your pinned/mute settings for it won't carry over."
                  : "You'll need a new invite link to rejoin, and your pinned/mute settings for it won't carry over."}
              {isOwner && !isPrivate ? (
                <span className="mt-3 block rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
                  You&apos;re the owner — leaving will hand ownership to the longest-standing admin (or member, if there&apos;s no admin). If you&apos;re the only one left, the chat won&apos;t have an owner afterward.
                </span>
              ) : null}
              {leaveError ? (
                <span role="alert" className="mt-3 block text-[13.5px] text-danger">
                  {leaveError}
                </span>
              ) : null}
            </>
          }
          confirmLabel={isPrivate ? "Leave chat" : `Leave ${kindLabel}`}
          destructive
          pending={leaveMutation.isPending}
          onConfirm={() => leaveMutation.mutate()}
          onClose={() => {
            setConfirmingLeave(false);
            setLeaveError(null);
          }}
        />
      ) : null}

      {confirmingReset ? (
        <ConfirmDialog
          title="Reset the invite link?"
          description={
            <>
              The current link will stop working. Anyone you&apos;ve already sent it to will need the new one.
              {resetMutation.isError ? (
                <span role="alert" className="mt-2 block text-danger">
                  Couldn&apos;t reset it. Check your connection and try again.
                </span>
              ) : null}
            </>
          }
          confirmLabel="Reset link"
          destructive
          pending={resetMutation.isPending}
          onConfirm={() => resetMutation.mutate()}
          onClose={() => setConfirmingReset(false)}
        />
      ) : null}

      {confirmingDelete ? (
        <ConfirmDialog
          title={`Delete ${title}?`}
          description={
            <>
              This deletes the {kindLabel} and all its messages for every member. This can&apos;t be undone.
              {deleteMutation.isError ? (
                <span role="alert" className="mt-2 block text-danger">
                  {deleteMutation.error instanceof ApiError && deleteMutation.error.status < 500
                    ? deleteMutation.error.message
                    : "Couldn't delete it. Check your connection and try again."}
                </span>
              ) : null}
            </>
          }
          confirmLabel="Delete for everyone"
          destructive
          pending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate()}
          onClose={() => setConfirmingDelete(false)}
        />
      ) : null}

      {canEditInfo ? (
        <EditChatDialog open={editOpen} onClose={() => setEditOpen(false)} channelId={channelId} myRole={myRole ?? "member"} />
      ) : null}

      {reportOpen ? <ReportDialog targetType="channel" targetId={channelId} targetLabel={title} onClose={() => setReportOpen(false)} /> : null}
    </div>
  );
}

/** A public chat's shareable URL. There's no `/@handle` route, so it's the
 * chat's own address — which opens as a preview with Join for non-members. */
function chatPublicUrl(channelId: string) {
  return `${typeof window === "undefined" ? "" : window.location.origin}/app/c/${channelId}`;
}

/** A link with Copy, Share (where the device supports it) and, optionally,
 * Reset. Copying is confirmed on the button and announced to screen readers. */
function ShareableLink({ url, display, shareTitle, onReset }: { url: string; display?: string; shareTitle: string; onReset?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    // Read after mount: `navigator` doesn't exist during server rendering.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopyFailed(false);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyFailed(true);
    }
  }

  async function share() {
    try {
      await navigator.share({ title: shareTitle, url });
    } catch {
      // Dismissed the share sheet — nothing to do.
    }
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="min-w-0">
        {display ? <div className="text-[15px] font-semibold text-fg">{display}</div> : null}
        <div className="select-all break-all text-[14px] text-accent-text">{url}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={copy}>
          {copied ? <Check className="size-[18px]" strokeWidth={2} aria-hidden /> : <Copy className="size-[18px]" strokeWidth={2} aria-hidden />}
          {copied ? "Copied" : "Copy link"}
        </Button>
        {canShare ? (
          <Button variant="secondary" onClick={share}>
            <Share2 className="size-[18px]" strokeWidth={2} aria-hidden />
            Share
          </Button>
        ) : null}
        {onReset ? (
          <Button variant="ghost" onClick={onReset}>
            <RotateCcw className="size-[18px]" strokeWidth={2} aria-hidden />
            Reset link
          </Button>
        ) : null}
      </div>
      <span role="status" aria-live="polite" className={cn("text-[13.5px]", copyFailed ? "text-danger" : "sr-only")}>
        {copied ? "Link copied" : copyFailed ? "Couldn't copy — select the link above and copy it yourself." : ""}
      </span>
    </div>
  );
}

function RoleBadge({ role }: { role: ChatRole }) {
  if (role === "member") return null;
  const Icon = role === "owner" ? Crown : ShieldCheck;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full px-2 text-[12px] font-semibold",
        role === "owner" ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent-text",
      )}
    >
      <Icon className="size-3.5" strokeWidth={2} aria-hidden />
      {role === "owner" ? "Owner" : "Admin"}
    </span>
  );
}

const tileClasses =
  "pressable flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-line bg-panel px-2 py-3 text-[13.5px] font-semibold text-fg transition-colors duration-[var(--dur-fast)] hover:border-line-strong hover:bg-sunken disabled:opacity-50";
const activeTileClasses = "border-transparent bg-accent-soft text-accent-text hover:border-transparent hover:bg-accent-soft";

function QuickAction({
  icon: Icon,
  label,
  onClick,
  href,
  active,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  href?: string;
  /** Visual "on" state (e.g. muted). The label itself names the action,
   * so this isn't exposed as aria-pressed too. */
  active?: boolean;
  disabled?: boolean;
}) {
  const body = (
    <>
      <Icon className="size-5" strokeWidth={1.9} aria-hidden />
      <span className="truncate">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} className={tileClasses}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cn(tileClasses, active && activeTileClasses)}>
      {body}
    </button>
  );
}
