import { apiFetch } from "./client";
import type {
  AdminRights,
  ChannelsPage,
  ChatPreview,
  ChatRole,
  EffectivePermissions,
  InvitePreview,
  MemberPermissions,
  PublicUser,
  RawChat,
} from "./types";

/** Shared TanStack Query key for GET /v1/channels/mine — used by both
 * ConversationList and ConversationView so they share one cache entry. */
export const CHANNELS_QUERY_KEY = ["channels", "mine"] as const;

export interface Participant {
  userId: string;
  username: string;
  firstName?: string;
  lastName?: string;
  role: ChatRole;
  avatarUrl?: string[];
}

/** GET /v1/channels/mine — one aggregation, cursor-paginated, pinned rows
 * always included on the first page. Replaces legacy GET /chats/my-chats. */
export function getChannelsMine(opts: { cursor?: string; folder?: string } = {}) {
  return apiFetch<ChannelsPage>("/v1/channels/mine", {
    query: { cursor: opts.cursor, folder: opts.folder },
  });
}

/** Finds or creates the deterministic 1:1 chat with this user. Legacy
 * endpoint, no v1 replacement — returns the bare chat document (RawChat). */
export function getOrCreateDirect(userId: string) {
  return apiFetch<RawChat>(`/chats/direct/${userId}`);
}

export interface CreateChatInput {
  name: string;
  link: string;
  type: "group" | "channel";
  members: string[];
  admins?: string[];
  description?: string;
  /** Public chats show up in search; private ones are joined by invite link. */
  isPublic?: boolean;
  /** Photo: `[url]` from `uploadImage` (wire name for the chat's `image`). */
  imageUrl?: string[];
}

/** Legacy endpoint, no v1 replacement. `members` are added as real
 * ChatMembers server-side when sent directly here. */
export function createChat(input: CreateChatInput) {
  /** `restrictedMemberIds`: people left out because their privacy doesn't let you add them. */
  return apiFetch<RawChat & { restrictedMemberIds?: string[] }>("/chats/create", {
    method: "POST",
    body: { admins: [], ...input },
  });
}

export function getParticipants(channelId: string) {
  return apiFetch<Participant[]>(`/chats/${channelId}/participants`);
}

/** Admin/owner only, group/channel only (400s for a DM or Saved Messages).
 * Its own doc comment says why this exists: "There was previously no way
 * to do this — the frontend's add-members step created DM chats instead."
 * `added`/`skipped` (already a member, or banned) let the caller report
 * exactly what happened rather than assuming every id landed — a
 * previously-left (not banned) user is silently reactivated and counted
 * as `added`. Also posts a real "members_added" system message into the
 * chat, so no separate notification step is needed. */
export function addMembers(channelId: string, userIds: string[]) {
  /** `restricted`: their "Groups & channels" privacy doesn't let you add them
   * (offer the invite link instead). */
  return apiFetch<{ added: string[]; skipped: string[]; restricted?: string[] }>(`/chats/${channelId}/members`, {
    method: "POST",
    body: { userIds },
  });
}

/** Both return the ChatMembers doc (not the Chat) — only `isMuted` from it
 * is actually used client-side. */
export function muteChat(channelId: string) {
  return apiFetch<{ isMuted: boolean }>(`/chats/${channelId}/mute`, { method: "POST" });
}

export function unmuteChat(channelId: string) {
  return apiFetch<{ isMuted: boolean }>(`/chats/${channelId}/mute`, { method: "DELETE" });
}

export function pinChat(channelId: string) {
  return apiFetch<void>(`/chats/${channelId}/pin`, { method: "POST" });
}

export function unpinChat(channelId: string) {
  return apiFetch<void>(`/chats/${channelId}/pin`, { method: "DELETE" });
}

/** Sets the order of your pinned chats (top first). */
export function reorderPinnedChats(channelIds: string[]) {
  return apiFetch<{ success: true }>("/v1/channels/mine/pins", { method: "PUT", body: { channelIds } });
}

/** Joins (or rejoins, if previously left) a public group/channel found via
 * search — idempotent, throws if banned. Response shape is an inconsistent
 * ChatMembers-doc-or-plain-object depending on the join/rejoin path, so
 * don't rely on it; just invalidate the channels cache after. */
export function subscribeToChannel(channelId: string) {
  return apiFetch<unknown>("/chats/subscribe", { method: "POST", query: { channelId } });
}

/** Leave a chat. For a **private DM** this is a soft-leave (the chat is
 * hidden from your list and rejoinable later, but you won't see messages
 * sent while you were away — a `hiddenAt` pointer, not a deletion). For a
 * **group/channel** your membership row is hard-deleted — rejoining later
 * starts fresh (default role, no pinned/mute settings carried over).
 *
 * If the leaver is the group/channel's owner, the backend promotes a
 * successor first (longest-tenured admin, falling back to longest-tenured
 * member) so the chat isn't left ownerless — unless no other members
 * remain, in which case it's simply left without an owner. A real 4xx
 * (e.g. "not a member") now propagates as a thrown `ApiError`, same as any
 * other endpoint — resolves to `true` on success. No realtime broadcast
 * exists for a plain member leaving (only a role-change broadcast when an
 * owner's departure promotes someone), so invalidate your own channel list
 * after a successful leave rather than expecting one. */
export function leaveChat(channelId: string) {
  return apiFetch<boolean>("/chats/unsubscribe", { method: "POST", query: { channelId } });
}

/** Admin/owner only. Legacy endpoint, no v1 replacement. This is a **full
 * replace**, not add/remove — always send the complete desired tag list.
 * Returns the raw updated `Chat` document (only `.tags` is used here). */
export function setChatTags(channelId: string, tags: string[]) {
  return apiFetch<RawChat>(`/chats/${channelId}/tags`, { method: "POST", body: { tags } });
}

/** Group/channel only (400s for private chats) — not restricted to
 * admin/owner server-side (any member can call it — confirmed by reading
 * ChatService.getBannedList's own guard, which only checks membership, not
 * role), but there's nothing to see unless you already have ban rights, so
 * client-side this is still gated behind admin/owner in the UI. */
export function getBannedUsers(channelId: string) {
  return apiFetch<{ users: PublicUser[] }>(`/chats/${channelId}/banned`);
}

/** Admin/owner only server-side. Bans and revokes membership in one step —
 * the target is immediately removed from the chat (`isJoined: false`), not
 * just blocked from rejoining. No protection against banning the owner or
 * a fellow admin server-side (confirmed by reading `ChatService.setBanned`
 * — only muting has that guard), so the UI hides the action for those
 * roles itself rather than relying on a 4xx. */
export function banUser(channelId: string, userId: string) {
  return apiFetch<void>(`/chats/${channelId}/ban/${userId}`, { method: "POST" });
}

/** Only lifts the ban — the user isn't re-added, they'd need to rejoin
 * themselves (the membership row's `isJoined` stays false either way). */
export function unbanUser(channelId: string, userId: string) {
  return apiFetch<void>(`/chats/${channelId}/ban/${userId}`, { method: "DELETE" });
}

export interface MemberForManagement extends PublicUser {
  userId: string;
  role: ChatRole;
  isBanned: boolean;
  mutedByAdmin: boolean;
  /** Admins (and the owner, all true); null for members. */
  adminRights: AdminRights | null;
  /** A member's exceptions to the group defaults (only the keys that were set). */
  permissions: Partial<MemberPermissions> | null;
  /** Who appointed this admin — an admin with "add admins" may only change admins they appointed. */
  promotedBy: string | null;
}

/** Despite its "for management" name and any-membership-only guard (not
 * restricted to admin/owner server-side), this returns full membership
 * *history* for the channel — every `chatmembers` row ever created,
 * including people who left normally, with no `isJoined` field to tell
 * them apart from current members (confirmed by reading
 * `ChatService.getMembersForManagement`: `find({channelId})`, no filter).
 * Don't use this as "the member list" — use `getParticipants()` for that,
 * and only cross-reference this by userId for `mutedByAdmin`/`isBanned`
 * on ids you already know are real current members. */
export function getMembersForManagement(channelId: string) {
  return apiFetch<MemberForManagement[]>(`/chats/${channelId}/members`);
}

/** Groups only — 400s for channels and private chats (confirmed by reading
 * `ChatService.setMutedByAdmin`; ban/unban has no such type restriction,
 * mute does). Admin/owner only; can't mute the owner; only the owner (not
 * a fellow admin) can mute an admin — the UI hides the action rather than
 * relying on the 4xx. Actually enforced, not just a flag: a muted member's
 * `POST /messages`/`send_message` is rejected server-side
 * ("You are muted in this group. You cannot send messages."). */
export function muteMember(channelId: string, userId: string) {
  return apiFetch<void>(`/chats/${channelId}/mute-member/${userId}`, { method: "POST" });
}

export function unmuteMember(channelId: string, userId: string) {
  return apiFetch<void>(`/chats/${channelId}/mute-member/${userId}`, { method: "DELETE" });
}

// ---- Group/channel management -------------------------------------------

export interface UpdateChatInput {
  name?: string;
  description?: string;
  /** Photo: `[url]` from `uploadImage`, or `[]` to remove it. */
  imageUrl?: string[];
  /** Owner only. */
  isPublic?: boolean;
  /** Channels: admins sign posts with their name (or not). */
  signature?: boolean;
  /** Owner only — the public @handle (3–64 of a-z, 0-9, _ and -). */
  link?: string;
}

/** Owner or admin. Admins may change name, description and photo only;
 *  visibility and the link are the owner's. Members get a `chat_updated`
 *  socket event. */
export function updateChat(channelId: string, input: UpdateChatInput) {
  return apiFetch<RawChat>(`/chats/update/${channelId}`, { method: "POST", body: input });
}

/** Public groups/channels, or any chat you're in. Doesn't join. */
export function getChatPreview(channelId: string) {
  return apiFetch<ChatPreview>(`/chats/preview/${channelId}`);
}

/** Owner only. Broadcasts `channel_roles_updated`. */
export function setAdmin(channelId: string, userId: string, makeAdmin: boolean) {
  return apiFetch<{ userId: string; role: ChatRole }>(`/chats/${channelId}/admins/${userId}`, {
    method: makeAdmin ? "POST" : "DELETE",
  });
}

/** Owner/admin. The link to share is `${origin}/app/join/${inviteCode}`. */
export function getInviteCode(channelId: string) {
  return apiFetch<{ inviteCode: string }>(`/chats/${channelId}/invite`);
}

/** Owner/admin — the old link stops working. */
export function resetInviteCode(channelId: string) {
  return apiFetch<{ inviteCode: string }>(`/chats/${channelId}/invite/reset`, { method: "POST" });
}

export function previewInvite(code: string) {
  return apiFetch<InvitePreview>(`/chats/invite/${encodeURIComponent(code)}`);
}

/** Works for private chats too — the code is the permission. */
export function joinByInvite(code: string) {
  return apiFetch<{ channelId: string }>(`/chats/invite/${encodeURIComponent(code)}/join`, { method: "POST" });
}

export function inviteLink(code: string) {
  return `${typeof window === "undefined" ? "" : window.location.origin}/app/join/${code}`;
}

// ---- Rights and permissions (backend chat/permissions.ts) ------------------

export const chatPermissionsKey = (channelId: string) => ["chats", channelId, "permissions"] as const;

/** Your effective rights here + the group's default member permissions.
 *  Refetch on the `chat_permissions_updated` / `channel_roles_updated` socket events. */
export function getChatPermissions(channelId: string) {
  return apiFetch<{ myPermissions: EffectivePermissions; defaultPermissions: MemberPermissions }>(
    `/chats/${channelId}/permissions`,
  );
}

/** Groups: what members may do by default. Needs the "banUsers" admin right. */
export function setDefaultPermissions(channelId: string, permissions: Partial<MemberPermissions>) {
  return apiFetch<{ defaultPermissions: MemberPermissions }>(`/chats/${channelId}/permissions`, {
    method: "PUT",
    body: permissions,
  });
}

/** Groups: exceptions for one member (any key overrides the default, either way). Needs "banUsers". */
export function setMemberPermissions(channelId: string, userId: string, permissions: Partial<MemberPermissions>) {
  return apiFetch<{ userId: string; permissions: Partial<MemberPermissions> | null }>(
    `/chats/${channelId}/members/${userId}/permissions`,
    { method: "PUT", body: permissions },
  );
}

export function clearMemberPermissions(channelId: string, userId: string) {
  return apiFetch<unknown>(`/chats/${channelId}/members/${userId}/permissions`, { method: "DELETE" });
}

/** Promote with these rights (missing keys → defaults: all but addAdmins), or update an
 *  admin's rights. Owner, or an admin with addAdmins (only rights they hold, only admins they
 *  appointed). Demote with `setAdmin(channelId, userId, false)`. */
export function setAdminRights(channelId: string, userId: string, rights: Partial<AdminRights>) {
  return apiFetch<{ userId: string; role: ChatRole; adminRights: AdminRights | null }>(
    `/chats/${channelId}/admins/${userId}`,
    { method: "PUT", body: rights },
  );
}

/** Owner only (or either person for a direct chat). Deletes it for everyone. */
export function deleteChat(channelId: string) {
  return apiFetch<unknown>(`/chats/delete/${channelId}`, { method: "DELETE" });
}
