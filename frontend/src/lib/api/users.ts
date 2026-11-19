import { apiFetch } from "./client";
import type {
  LastSeenBucket,
  NotificationLevel,
  PrivacyKey,
  PrivacyRulePatch,
  PrivacyRulesView,
  PrivacySettings,
  PublicUser,
  QuickReactionItem,
} from "./types";

export const BLOCKED_QUERY_KEY = ["users", "blocked"] as const;

/** Same rules as global people search (PeopleDiscoveryService on the backend):
 * names only match people you already know (your contacts, people you share a
 * chat with); strangers only by @username (4+ characters match as a prefix,
 * shorter must be exact) and only if their privacy allows. Never email/phone. */
export function searchUsers(query: string) {
  return apiFetch<PublicUser[]>("/users/search", { query: { q: query } });
}

/** Single-user only — legacy unversioned path (no `ids=` batch variant exists
 * anywhere in this backend, confirmed by reading every controller). Seed a
 * presence snapshot for one user (e.g. a DM's other side) before any
 * `user_status_changed` socket event has arrived for them. */
export interface UserStatus {
  userId: string;
  lastSeen: string | null;
  isOnline: boolean;
  /** Set (isOnline false, lastSeen null) when their last-seen privacy hides the
   * exact time from you — or you hide yours from them (it's reciprocal). */
  lastSeenBucket?: LastSeenBucket;
}

export function getUserStatus(userId: string) {
  return apiFetch<UserStatus>(`/users/${userId}/status`);
}

/** IDs only — no bulk/hydrated variant exists (confirmed by reading every
 * controller), so a UI listing blocked users has to fetch each profile
 * separately (getUserProfile in contacts.ts). */
export function getBlockedUserIds() {
  return apiFetch<string[]>("/users/blocked");
}

/** Whether `userId` has blocked the current user (not the other direction —
 * there's no endpoint to check "have I blocked them," only getBlockedUserIds). */
export function hasBlockedMe(userId: string) {
  return apiFetch<{ blocked: boolean }>(`/users/block/check/${userId}`);
}

/** Idempotent — a no-op if already blocked. Server-side, this only filters
 * live socket delivery of their DMs to you and hides you from their
 * people-search; it does NOT stop them creating/reopening the DM or reject
 * the send outright (confirmed by reading chat.gateway.ts/message.service.ts
 * — messages still persist, you'd see them on your next history fetch). */
export function blockUser(userId: string) {
  return apiFetch<void>(`/users/block/${userId}`, { method: "POST" });
}

export function unblockUser(userId: string) {
  return apiFetch<void>(`/users/block/${userId}`, { method: "DELETE" });
}

/** "all": every message. "mentions": only when @mentioned. "none": never
 * push (still delivered live over the socket if the app is open) — this is
 * purely about push delivery, not an in-app mute (that's per-chat, see
 * muteChat/unmuteChat in chats.ts). Enforced server-side in
 * notification.service.ts's per-recipient send decision. */
export const DEFAULT_PRIVACY: PrivacySettings = {
  phoneNumber: "contacts",
  email: "nobody",
  lastSeen: "everybody",
  profilePhotos: "everybody",
  bio: "everybody",
  calls: "everybody",
  groupInvites: "everybody",
  forwards: "everybody",
  findByUsername: "everybody",
  findByPhoneOrEmail: "contacts",
};

export const PRIVACY_QUERY_KEY = ["users", "privacy"] as const;

/** All your privacy settings with their "Always allow" / "Never allow" people. */
export function getPrivacyRules() {
  return apiFetch<PrivacyRulesView>("/users/privacy");
}

/** Send only what changed (an audience, or `{ audience?, allow?, deny? }` with
 * id lists that replace the stored ones); returns every setting as saved. */
export function updatePrivacy(patch: Partial<Record<PrivacyKey, PrivacyRulePatch>>) {
  return apiFetch<PrivacyRulesView>("/users/privacy", { method: "PATCH", body: patch });
}

/** The audiences of a full rules view — what `me.privacy` holds. */
export function audiencesOf(rules: PrivacyRulesView): PrivacySettings {
  return Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, v.audience])) as PrivacySettings;
}

/** Which of these people won't let you add them to a group or channel. */
export function getRestrictedForGroups(userIds: string[]) {
  return apiFetch<{ restricted: string[] }>("/users/addable", { method: "POST", body: { userIds } });
}

export function updateNotificationLevel(level: NotificationLevel) {
  return apiFetch<{ success: boolean }>("/users/notifications", { method: "PATCH", body: { level } });
}

/** Registers this browser's FCM token for background/killed-app push — an
 * upsert keyed on the token itself, so calling it again on refresh is safe.
 * The backend's own doc calls this "Android/Flutter only," but the actual
 * send call (`getMessaging().send({token, ...})`) doesn't care which
 * platform a token came from; a web-sourced FCM token registers and
 * receives push the same way. */
export function registerPushToken(token: string, ua?: string) {
  return apiFetch<{ success: true }>("/v1/push/tokens", { method: "POST", body: { token, ua } });
}

/** Call on logout so a signed-out browser stops receiving push. */
export function unregisterPushToken(token: string) {
  return apiFetch<{ success: true }>("/v1/push/tokens", { method: "DELETE", body: { token } });
}

/** Sets the double-tap reaction: a plain emoji, or an animated emoji from a
 * pack you own or added (`packItemId`). There's no separate quick-reaction
 * *sending* endpoint — the client reacts with the saved value via
 * `POST /messages/:id/reaction`. */
export function updateQuickReaction(input: { emoji: string } | { packItemId: string }) {
  return apiFetch<boolean>("/users/quick-reaction", { method: "PATCH", body: input });
}

/** One recent emoji: a plain one (`emoji`), or an animated one (`item`). Newest first. */
export interface RecentEmojiEntry {
  key: string;
  emoji: string | null;
  fallback: string;
  item: QuickReactionItem | null;
}

/** Your recent emoji (plain and animated), kept on the server, at most 30. */
export function getRecentEmoji() {
  return apiFetch<RecentEmojiEntry[]>("/users/me/recent-emoji");
}

/** Records a pick at the front of the recent list; returns the updated list. */
export function addRecentEmoji(input: { emoji: string } | { packItemId: string }) {
  return apiFetch<RecentEmojiEntry[]>("/users/me/recent-emoji", { method: "POST", body: input });
}
