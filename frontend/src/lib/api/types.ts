// Hand-written against the REAL chat-app/backend (the refactored /v1 API),
// verified by reading its DTO source (src/common/dto/user-view.dto.ts,
// src/channels/dto/channel-summary.dto.ts) and by direct curl testing
// against a running instance — not from its checked-in openapi.json, which
// is stale (confirmed: it documents zero /v1 paths despite ~20 being live).
//
// This is a clean contract. The workaround types this file used to need
// (password-hash-leak stripping, the avatarUrl/image phantom-field bug) are
// gone — don't reintroduce them.

export interface PublicUser {
  _id: string;
  username: string;
  firstName: string;
  lastName: string;
  /** `[main photo]` — always a still (a video's poster), cheap for lists. */
  avatarUrl: string[];
  /** Set when the main profile photo is a video: loop it on the profile only. */
  avatarVideoUrl?: string | null;
  bio: string;
}

/** GET /v1/auth/me / the `user` field on login/register/refresh responses. */
export type NotificationLevel = "all" | "mentions" | "none";

export interface QuickReactionItem {
  packItemId: string;
  packId: string;
  relativePath: string;
  thumbPath: string;
  stillPath: string;
}

export interface Me extends PublicUser {
  email: string;
  phoneNumber: string;
  bigEmojis: boolean;
  /** Plain emoji — or, when `quickReactionItem` is set, its emoji fallback. */
  quickReaction: string;
  /** Set when the quick reaction is an animated emoji: react with its
   *  `packItemId`. Paths resolve with resolveMediaUrl(). */
  quickReactionItem?: QuickReactionItem | null;
  lastSeen: string | null;
  notificationLevel: NotificationLevel;
  /** Your privacy audiences (exceptions: GET /users/privacy). Older backends
   *  omit it or send only the two discovery keys. */
  privacy?: Partial<PrivacySettings>;
}

/** "contacts" = people *you* saved as contacts (Telegram semantics). */
export type PrivacyAudience = "everybody" | "contacts" | "nobody";

/** Every Telegram-style privacy setting, in Settings order. */
export const PRIVACY_KEYS = [
  "phoneNumber",
  "email",
  "lastSeen",
  "profilePhotos",
  "bio",
  "calls",
  "groupInvites",
  "forwards",
  "findByUsername",
  "findByPhoneOrEmail",
] as const;
export type PrivacyKey = (typeof PRIVACY_KEYS)[number];

/** Audiences only — what `/me.privacy` carries. Defaults: phone → contacts,
 * email → nobody, find by phone/email → contacts, everything else → everybody. */
export type PrivacySettings = Record<PrivacyKey, PrivacyAudience>;

/** One setting with its exception lists ("Always allow" / "Never allow"). */
export interface PrivacyRuleView {
  audience: PrivacyAudience;
  allow: PublicUser[];
  deny: PublicUser[];
}
export type PrivacyRulesView = Record<PrivacyKey, PrivacyRuleView>;

/** PATCH /users/privacy value: an audience, or a partial rule (lists are ids
 * and replace the stored list). */
export type PrivacyRulePatch = PrivacyAudience | { audience?: PrivacyAudience; allow?: string[]; deny?: string[] };

/** What people who can't see your exact last seen get instead. */
export type LastSeenBucket = "recently" | "within_week" | "within_month" | "long_ago";

export interface AuthResponse {
  access_token: string;
  /** Absent for the web app: the refresh token arrives as an HttpOnly cookie instead. */
  refresh_token?: string;
  user: Me;
}

export interface Session {
  _id: string;
  device: string;
  ip: string;
  lastUsedAt: string;
  createdAt: string;
}

export type ChatKind = "private" | "group" | "channel" | "saved_messages";
export type ChatRole = "owner" | "admin" | "member";

/** GET /v1/channels/mine — one row per chat, everything the list needs
 * without a follow-up request. Cursor-paginated (see ChannelsPage). */
export interface ChannelSummary {
  channelId: string;
  type: ChatKind;
  /** Blank for private chats — use `otherUser` instead. */
  name: string;
  image: string[];
  link: string | null;
  /** Group/channel description (null for DMs). */
  description?: string | null;
  /** Public groups/channels appear in search; private ones are invite-link only. */
  isPublic?: boolean;
  /** Channels: posts show their author's name next to the time. */
  signature?: boolean;
  myRole: ChatRole;
  /** What you may do here — gate every action on this, not on myRole. */
  myPermissions?: EffectivePermissions;
  isPinned: boolean;
  isMuted: boolean;
  lastReadMessageId: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** True when the chat's last message is yours (drives the read tick in the chat list). */
  lastMessageMine?: boolean;
  /** Your last message in a direct chat: whether your partner has read it. Null when the last
   *  message isn't yours; always false in groups/channels. */
  lastMessageRead?: boolean | null;
  /** You cleared the history past the last message: show no preview or time (the chat
   *  keeps its place in the list, like Telegram). */
  historyCleared?: boolean;
  /** Group/channel only — absent for private chats. */
  memberCount?: number;
  /** Admin/owner-editable, feeds folder `includeTags` filters. Always present (empty array when unset). */
  tags: string[];
  /** True when the chat's last message postdates this member's own read
   * pointer (or they've never read it at all) — a boolean, not a count.
   * Same definition the `onlyUnread` folder filter already used server-side. */
  unread: boolean;
  /** Private chats only — the other member, already resolved server-side. */
  otherUser?: PublicUser;
  /** Groups/channels with a live voice chat (chat-list indicator, the chat's
   *  top bar). Kept current by the `group_call_updated` socket event. */
  activeCall?: { callId: string; startedAt: number | null; participantCount: number };
}

export interface ChannelsPage {
  items: ChannelSummary[];
  nextCursor: string | null;
}

/** A chat matches a folder when it satisfies every non-empty criterion here
 * simultaneously (`includeTypes`/`includeTags` are OR'd within themselves,
 * AND'd against each other) — computed server-side, in the same aggregation
 * as GET /v1/channels/mine's `?folder=` param, not client-side. All optional
 * on create/update (server fills omitted ones with an empty/false default). */
export interface ChatFolderFilters {
  includeTypes: ChatKind[];
  includeTags: string[];
  includeChannelIds: string[];
  excludeChannelIds: string[];
  onlyUnread: boolean;
}

/** GET/POST/PATCH /v1/folders — a user's own saved chat-list filter, shown
 * as a tab above the chat list (Telegram-style). `order` is ascending;
 * a fresh one is appended last. */
export interface ChatFolder {
  _id: string;
  ownerId: string;
  name: string;
  order: number;
  filters: ChatFolderFilters;
  createdAt: string;
  updatedAt: string;
}

/** Legacy raw chat document (chat/schema/chat.schema.ts) — returned as-is,
 * not through a DTO mapper, by POST /chats/create and GET /chats/direct/:userId.
 * Those two legacy endpoints have no v1 replacement (GET /v1/channels/mine is
 * list-only), so chat *creation* still goes through this shape. Don't use it
 * for anything else — prefer ChannelSummary wherever the backend gives you one. */
export interface RawChat {
  _id: string;
  link: string;
  type: ChatKind;
  name: string;
  admins: string[];
  description: string | null;
  image: string[];
  tags: string[];
  isLocked: boolean;
  createdAt: string;
  updatedAt: string;
}

export function channelDisplayName(c: Pick<ChannelSummary, "type" | "name" | "otherUser">): string {
  if (c.otherUser) return [c.otherUser.firstName, c.otherUser.lastName].filter(Boolean).join(" ") || c.otherUser.username;
  return c.name;
}

export type MessageType = "text" | "image" | "file" | "audio" | "system" | "gif" | "sticker" | "voice" | "video" | "video_note" | "voice_call";

/** A reaction is either a plain unicode emoji (`emoji` set, `packItemId` null)
 * or a sticker/animated-emoji pack item (`packItemId` set, `emoji` null) —
 * never both, mirroring the backend's `MessageReaction` schema. `relativePath`/
 * `packId` are only meaningful alongside a `packItemId` — resolve the former
 * with resolveMediaUrl() from lib/media-url.ts, same as a PackItem. */
export interface MessageReaction {
  emoji: string | null;
  packItemId: string | null;
  relativePath: string | null;
  packId: string | null;
  count: number;
  /** Whether the current user is one of the reactors. */
  me: boolean;
}

export interface ReplySnapshot {
  messageId: string;
  senderName: string;
  snippet: string;
  type: MessageType;
}

/** A single reaction toggle's response — NOT a full message. Confirmed
 * empirically: `POST /messages/:id/reaction` returns
 * `{channelId, messageId, emoji, packItemId, userId, action, reactions}`, not
 * the message object the old backend returned. Patch just `reactions` into an
 * already-cached message; don't treat this as a replacement message.
 * `emoji`/`packItemId` echo back whichever one the request sent (exactly one
 * is non-null), regardless of `action`. */
export interface ReactionToggleResult {
  channelId: string;
  messageId: string;
  emoji: string | null;
  packItemId: string | null;
  userId: string;
  action: "added" | "removed";
  reactions: MessageReaction[];
}

/** Server-derived facts about one attachment (backend `AttachmentMetaEntry`). The optional
 * fields are only set on file/music attachments; stickers carry width/height. */
export interface AttachmentMeta {
  mediaId: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  /** `video` marks a video inside a mixed photo/video album. */
  kind?: "file" | "audio" | "video";
  /** Video: its poster frame (`/uploads/media/...`). */
  posterUrl?: string | null;
  /** File/music: the name it was sent with (one per attachment in a file group). */
  fileName?: string | null;
  sizeBytes?: number | null;
  mimeType?: string | null;
  /** Music: track length (from the file). */
  durationSec?: number | null;
  /** Music: from the file's own tags. */
  title?: string | null;
  artist?: string | null;
  /** `/uploads/media/...` — an image file's thumbnail or a track's cover art (resolve it
   *  with `resolveAttachmentUrl`). `width`/`height` describe this image. */
  thumbUrl?: string | null;
}

export interface ChatMessage {
  _id: string;
  channelId: string;
  senderId: PublicUser | string;
  content: string;
  type: MessageType;
  attachments: string[];
  /** Keyed by the exact URL in `attachments` — not every attachment has an
   * entry (e.g. a GIF from a path that never went through `MediaService`).
   * Built server-side from the real `MediaAsset` row (see backend's
   * `MessageService.buildAttachmentMeta`), never from client-claimed values. */
  attachmentMeta?: Record<string, AttachmentMeta> | null;
  replyTo: string | null;
  /** Captured once at send time — no more over-fetching a populated
   * original message just to show a 1-line quote. */
  replySnapshot: ReplySnapshot | null;
  isEdited: boolean;
  isPinned: boolean;
  mentions: string[];
  /** Finally persisted (the old backend accepted these in the DTO but had
   * no schema field for either — confirmed dropped silently). */
  /** Animated emoji drawn inline over unicode fallback spans in `content`
   *  (UTF-16 offsets). Absent on messages from before the feature existed. */
  customEmoji?: { offset: number; length: number; packItemId: string; packId?: string; relativePath: string; stillPath?: string }[];
  durationSec: number | null;
  waveform: number[] | null;
  originalFilename: string | null;
  deletedFor: string[];
  /** `userId` only when the author's "Forwarded messages" privacy allowed a
   *  link; `hidden` when it didn't (show the name, not as a link). */
  forwardFrom: { userId?: string; name: string; avatarUrl?: string; hidden?: boolean } | null;
  /** Channels with signatures on: the author's name, shown next to the time. Null otherwise. */
  signature?: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  /** An aggregated array now, not a `{emoji: userId[]}` map — one batched
   * query per page server-side instead of the whole map on every message. */
  reactions: MessageReaction[];
  /** Set together when this is a sticker/animated-emoji message sent from a pack item —
   * resolved + authorized server-side from the send call's `packItemId` (owner-or-subscriber,
   * same rule as reacting with one). Lets a received sticker be traced back to its pack so it
   * can be tapped to open/add it — otherwise null. A forward copies these from the original. */
  packId: string | null;
  packItemId: string | null;
}

/** GET /v1/messages/:messageId/reads — author-only, and only for DMs/groups
 * (channels always come back empty, never throw). See
 * MessageInfoService.getReadInfo. `readAt` is null when the read time is no
 * longer known (read times are kept for 7 days; older reads still count). */
export interface SeenBy {
  messageId: string;
  chatType: "private" | "group" | "channel";
  /** Newest read first. Empty when `hidden`. */
  readers: { user: PublicUser; readAt: string | null }[];
  /** How many have read it (set even when `hidden`). */
  total: number;
  /** Members besides the author who could have read it. */
  eligible: number;
  /** False when the message is older than the 7-day read-time window. */
  kept: boolean;
  /** Group too large (>100 members) to list readers — count only. */
  hidden: boolean;
  /** Legacy bare pairs (the read tick only needs the count). */
  readBy: { userId: string; readAt: string | null }[];
}

/** GET /v1/messages/:messageId/reactions — who reacted, newest first. */
export interface MessageReactionList {
  messageId: string;
  total: number;
  reactions: {
    user: PublicUser;
    emoji: string | null;
    packItemId: string | null;
    relativePath: string | null;
    packId: string | null;
    reactedAt: string;
  }[];
}

/** GET /v1/contacts — one row per saved contact. Never includes phone/email
 * (mutual or not, by design) — call getUserProfile() separately for those. */
export interface ContactSummary {
  /** The Contact row's own id — use for rename/remove, NOT the same as user._id. */
  _id: string;
  user: PublicUser;
  customName: string | null;
  savedAt: string;
  isOnline: boolean;
  /** An existing 1:1 DM with this contact, if one exists. */
  channelId: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

/** GET /users/by-id/:userId or /users/:username — phoneNumber/email are
 * present only when viewing your own profile or a MUTUAL contact (both
 * sides have each other added; one-sided doesn't count). */
/** Another user's profile as you may see it: photos/bio already filtered by
 * their privacy; phone/email only present when their privacy shows them to you. */
export interface ProfileView extends PublicUser {
  phoneNumber?: string;
  email?: string;
  /** Their "Calls" privacy (and no block either way) lets you call them. */
  canCall?: boolean;
  /** Their "Groups & channels" privacy lets you add them to a group. */
  canAddToGroups?: boolean;
}

export type SearchScope = "people" | "channels" | "messages";

/** GET /v1/search?scope=channels — platform-wide, not membership-scoped
 * (can surface groups/channels you haven't joined). Never private DMs or
 * Saved Messages (excluded server-side by `type`). */
export interface ChannelSearchHit {
  _id: string;
  type: "channel" | "group";
  name: string;
  description: string | null;
  image: string[];
  /** Public handle, shown as @link. */
  link: string;
  isPublic: boolean;
  memberCount: number;
  /** Already in it → "Open"; otherwise "Join". */
  isMember: boolean;
}

/** GET /v1/search?scope=messages — restricted server-side to the caller's
 * own (non-banned) channels. No message-level jump target beyond channelId
 * — opens the channel, doesn't scroll to the message. */
export interface MessageSearchHit {
  _id: string;
  channelId: string;
  snippet: string;
  createdAt: string;
  /** Raw text, for highlighting the match ("" for non-text messages). */
  content?: string;
  senderId?: string;
  senderName?: string;
  /** The chat it's in, resolved for display (other person for a DM). */
  chat?: { type: ChatKind; name: string; image: string[]; otherUser?: PublicUser };
}

/** GET /chats/preview/:channelId — a public group/channel (or one you're in).
 *  404s for private chats you aren't a member of. */
// ---- Rights (backend: chat/permissions.ts) ----------------------------------

export const ADMIN_RIGHT_KEYS = [
  "changeInfo",
  "deleteMessages",
  "banUsers",
  "inviteUsers",
  "pinMessages",
  "addAdmins",
  "postMessages",
  "editMessages",
] as const;
export type AdminRightKey = (typeof ADMIN_RIGHT_KEYS)[number];
/** Per admin. `postMessages`/`editMessages` (others' posts) only matter in channels.
 *  `banUsers` also covers restricting members and changing member permissions. */
export type AdminRights = Record<AdminRightKey, boolean>;

export const MEMBER_PERMISSION_KEYS = [
  "sendMessages",
  "sendMedia",
  "sendStickers",
  "sendVoice",
  "addMembers",
  "pinMessages",
  "changeInfo",
] as const;
export type MemberPermissionKey = (typeof MEMBER_PERMISSION_KEYS)[number];
/** Groups: what members may do. sendMedia = photos/videos/files; sendStickers =
 *  stickers & GIFs; sendVoice = voice and round video messages. */
export type MemberPermissions = Record<MemberPermissionKey, boolean>;

export interface EffectivePermissions {
  role: ChatRole | null;
  /** Member-level actions (all true for the owner; derived from rights for admins). */
  member: MemberPermissions;
  /** Admin rights (all false for plain members). */
  admin: AdminRights;
  canPost: boolean;
  /** Owner of a group/channel, or either person in a direct chat. */
  canDeleteChat: boolean;
}

export interface ChatPreview {
  _id: string;
  type: ChatKind;
  name: string;
  image: string[];
  link: string;
  description: string | null;
  isPublic: boolean;
  /** Channels: posts show their author's name next to the time. */
  signature?: boolean;
  memberCount: number;
  isMember: boolean;
  myRole: ChatRole | null;
  myPermissions: EffectivePermissions;
}

/** GET /users/:id/photos — main first; everyone can browse them. */
export interface ProfilePhoto {
  id: string;
  url: string;
  kind: "image" | "video";
  /** Still frame for a video. */
  posterUrl: string | null;
  createdAt: string;
  isMain: boolean;
}

/** GET /chats/invite/:code — what an invite link leads to. */
export interface InvitePreview {
  _id: string;
  type: ChatKind;
  name: string;
  image: string[];
  link: string;
  description: string | null;
  isPublic: boolean;
  memberCount: number;
  isMember: boolean;
}

// ---- Packs (stickers & animated emoji) — see docs/PACKS_AND_BOTS_FRONTEND_BRIEF.md ----
// Backend-verified live: GET /v1/packs/mine, /search, /:packId, POST .../subscribe all match
// this shape exactly. One real, load-bearing gap found during verification:
// GET /v1/packs/search-items 500s with no `q` — always pass a non-empty query to it.

export type PackType = "sticker" | "emoji";

export interface PackSummary {
  id: string;
  type: PackType;
  name: string;
  description: string | null;
  ownerId: string;
  /** Invite-link segment — build a share link as `/packs/<slug>` or similar. */
  slug: string;
  tags: string[];
  /** Search discoverability only, not access — a private pack is still
   * fully viewable/addable by anyone with its slug. */
  isPublic: boolean;
  itemCount: number;
  totalUsageCount: number;
  /** Both relative to the caller. */
  isOwner: boolean;
  isSubscribed: boolean;
}

export interface PackItem {
  id: string;
  /** Bare relative path, NOT a server-resolved absolute URL (unlike message
   * attachments) — resolve with resolveMediaUrl() from lib/media-url.ts. */
  relativePath: string;
  /** 128px variant, animation kept — use for grids, inline emoji, reactions.
   *  Absent from servers older than this field: fall back to relativePath. */
  thumbPath?: string;
  /** 128px first frame, for when animated media is turned off. */
  stillPath?: string;
  animated?: boolean;
  /** Original's pixel size — stickers aren't all square. Absent from older servers. */
  width?: number | null;
  height?: number | null;
  keywords: string[];
  usageCount: number;
}

export interface PackDetail extends PackSummary {
  items: PackItem[];
}

/** GET /v1/packs/search-items — scoped server-side to packs already in the
 * caller's own collection (like Telegram: searching finds items you have,
 * not the whole catalog). */
export interface PackItemSearchHit extends PackItem {
  packId: string;
}

// ---- Bots — a server-driven menu tree, never a chat-style text interface ----

export interface BotDirectoryEntry {
  key: string;
  name: string;
  description: string;
  avatarUrl?: string;
}

export interface BotFormField {
  key: string;
  label: string;
  kind: "text" | "textarea" | "toggle" | "select" | "file" | "keywords";
  required?: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  /** For kind "file" — allow choosing more than one. */
  multiple?: boolean;
  accept?: string;
}

export interface BotAction {
  id: string;
  label: string;
  type: "navigate" | "invoke" | "form";
  style?: "default" | "primary" | "destructive";
  /** type "navigate" — which screen to fetch next (GET only, no server effect). */
  screenId?: string;
  /** type "form" — render these, collect values, merge into params, then invoke. */
  fields?: BotFormField[];
  /** Show a confirm dialog with this text before firing invoke/form. */
  confirmText?: string;
  /** Opaque context echoed back verbatim (merged with form values) when this fires. */
  params?: Record<string, unknown>;
}

export interface BotMenuItem {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  badge?: string;
  action: BotAction;
}

export interface BotMenuScreen {
  screenId: string;
  title: string;
  subtitle?: string;
  presentation?: "conversation";
  /** Show once, e.g. as a toast, after landing on this screen. */
  toast?: string;
  items: BotMenuItem[];
  /** Page-level buttons, not tied to a row (e.g. "Create a pack"). */
  actions: BotAction[];
}

export function senderName(sender: PublicUser | string): string {
  if (typeof sender === "string") return "Unknown";
  return [sender.firstName, sender.lastName].filter(Boolean).join(" ") || sender.username;
}

export function senderId(sender: PublicUser | string): string {
  return typeof sender === "string" ? sender : sender._id;
}
