import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { ChatType } from "src/enum/base.enum";

@Schema({
  collection: "chats",
  timestamps: true,
  versionKey: false,
  toJSON: {
    transform(_doc, ret: Record<string, unknown>) {
      delete ret.isDeleted;
      // The invite code is a secret — only GET /chats/:id/invite (owner/admin) hands it out.
      delete ret.inviteCode;
      return ret;
    },
  },
})
export class Chat {
  @Prop()
  link: string;

  @Prop({ enum: ChatType })
  type: ChatType;

  @Prop()
  name: string;

  /**
   * Read-only mirror of every `chatmembers` row with `role: admin` in this channel, kept in
   * sync by `ChatService.recomputeChatAdmins` (frontend convenience only — `chatmembers.role`
   * is the single source of truth for authorization; nothing reads this field to make an
   * access-control decision). See docs/plans/BACKEND_PLAN.md B2.
   */
  @Prop({ type: [Types.ObjectId], ref: "User", default: [] })
  admins: Types.ObjectId[];

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: [String], default: [] })
  image: string[];

  /** Multiple tags for categorizing / filtering chats */
  @Prop({ type: [String], default: [] })
  tags: string[];

  /** Set by an admin (B10, docs/plans/BACKEND_PLAN.md) — blocks new messages while true,
   *  enforced in `MessageService.create`. */
  @Prop({ type: Boolean, default: false })
  isLocked: boolean;

  /**
   * Groups/channels only. Public: findable in search, readable before joining,
   * joinable by anyone, and `link` acts as its public handle. Private (the
   * default, as in Telegram): only members can find, read or open it; people
   * join through the invite link below.
   */
  @Prop({ type: Boolean, default: false })
  isPublic: boolean;

  /** Groups: what plain members may do (chat/permissions.ts). Missing keys use
   *  DEFAULT_MEMBER_PERMISSIONS. */
  @Prop({ type: Object, default: null })
  defaultPermissions: Record<string, boolean> | null;

  /** Channels only (Telegram's "Signatures"). Off: posts show the channel as their author and
   *  nobody's name is sent to subscribers. On: each post also carries its author's display name
   *  (only the name — no id, username or photo) next to the timestamp. */
  @Prop({ type: Boolean, default: false })
  signature: boolean;

  /** Secret code for the chat's invite link (groups/channels). Owners and
   *  admins can view and reset it; resetting revokes the old link. */
  @Prop({ type: String, default: undefined })
  inviteCode?: string;
}

export const ChatSchema = SchemaFactory.createForClass(Chat);

ChatSchema.index({ link: 1 }, { unique: true, sparse: true });
ChatSchema.index({ inviteCode: 1 }, { unique: true, sparse: true });
ChatSchema.index({ isPublic: 1, type: 1 });
ChatSchema.index({ type: 1 });
ChatSchema.index({ name: "text", description: "text" });
ChatSchema.index({ tags: 1 });
ChatSchema.index({ isDeleted: 1 });
