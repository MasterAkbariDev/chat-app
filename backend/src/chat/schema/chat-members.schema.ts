import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { UserRole } from "src/enum/base.enum";

@Schema({ timestamps: true })
export class ChatMembers {
  @Prop({ required: true, type: String })
  channelId: string;

  @Prop({ required: true, type: String })
  userId: string;

  @Prop({ required: true, enum: UserRole })
  role: UserRole;

  @Prop({ type: String, default: null })
  lastReadMessageId: string | null;

  @Prop({ type: Date, default: null })
  lastReadAt: Date | null;

  /** User has pinned this chat to the top of their list */
  @Prop({ type: Boolean, default: false })
  isPinned: boolean;

  /** Position among this user's pinned chats (ascending; drag-to-reorder). Null for a chat
   *  pinned before ordering existed — those sort after the ordered ones, by recency. */
  @Prop({ type: Number, default: null })
  pinOrder: number | null;

  /**
   * Per-member "last visible message" when it differs from the channel's (`chat_state`):
   * set when this member deleted the channel's latest message(s) for themselves only.
   * Only valid while `anchorAt` still equals `chat_state.lastMessageAt` — any newer message
   * (or a delete-for-everyone recompute) moves the channel's last message and makes this
   * stale automatically, so it never needs clearing on the hot send path.
   */
  @Prop({ type: Object, default: null })
  lastVisibleOverride: {
    anchorAt: Date | null;
    lastMessageAt: Date | null;
    lastMessagePreview: string | null;
  } | null;

  /** User has muted notifications for this chat */
  @Prop({ type: Boolean, default: false })
  isMuted: boolean;

  /** User has been banned from this chat (set by admin) */
  @Prop({ type: Boolean, default: false })
  isBanned: boolean;

  /** User is muted by admin - cannot send messages but can read and react */
  @Prop({ type: Boolean, default: false })
  mutedByAdmin: boolean;

  @Prop({ type: Boolean, default: true })
  isJoined: boolean;

  /** Admins only: which admin rights this admin has (see chat/permissions.ts). Missing
   *  keys fall back to DEFAULT_ADMIN_RIGHTS, so older admins keep what they had. */
  @Prop({ type: Object, default: null })
  adminRights: Record<string, boolean> | null;

  /** Who promoted this admin — an admin may only edit or demote admins they appointed. */
  @Prop({ type: String, default: null })
  promotedBy: string | null;

  /** Per-person exceptions to the chat's default member permissions (groups). Any key
   *  set here overrides the default, in either direction. */
  @Prop({ type: Object, default: null })
  permissions: Record<string, boolean> | null;

  /**
   * "Everything created before this timestamp is hidden for this user" (B5,
   * docs/plans/BACKEND_PLAN.md). Replaces bulk-writing `deletedFor` onto every historical
   * message when a user leaves a private chat (was O(channel history) per leave) with a
   * single pointer write; message reads additionally filter on `createdAt > hiddenAt` when
   * this is set. Not cleared on rejoin — it's a permanent "left before this point" boundary,
   * new messages sent after rejoining are created after it and so remain visible.
   */
  @Prop({ type: Date, default: null })
  hiddenAt: Date | null;

  /** Per-chat wallpaper override (private and group chats) */
  @Prop({ type: Types.ObjectId, ref: "Wallpaper", default: null })
  chatWallpaperId: Types.ObjectId | null;

  /** Local visual overrides when accepting a shared wallpaper */
  @Prop({ type: Number, default: null })
  wallpaperBlur: number | null;

  @Prop({ type: Number, default: null })
  wallpaperDim: number | null;

  @Prop({ type: Number, default: null })
  wallpaperBrightness: number | null;
}

export const ChatMembersSchema = SchemaFactory.createForClass(ChatMembers);

// B0: the hottest query in the app (`findOne({channelId, userId})`) was an unindexed
// collection scan, and had no uniqueness constraint (duplicate membership rows under
// concurrency). See docs/DATABASE_AUDIT.md.
ChatMembersSchema.index({ channelId: 1, userId: 1 }, { unique: true });
ChatMembersSchema.index({ userId: 1, isJoined: 1 });
ChatMembersSchema.index({ channelId: 1, role: 1 });
ChatMembersSchema.index({ channelId: 1, isBanned: 1 });
// B5: backs the author-only "seen by" lookup (members whose lastReadAt >= message.createdAt).
ChatMembersSchema.index({ channelId: 1, lastReadAt: 1 });
