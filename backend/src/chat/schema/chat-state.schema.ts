import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";

/**
 * Denormalized per-channel summary, maintained by `ChatStateListener` off domain events
 * (`message.created|deleted`, `membership.changed`) rather than computed live. Exists so
 * `GET /v1/channels/mine` can list N chats in one aggregation instead of aggregating the whole
 * `messages`/`chatmembers` collections per request. See docs/plans/BACKEND_PLAN.md B2.
 */
@Schema({ collection: "chat_state", timestamps: true, versionKey: false })
export class ChatState {
  @Prop({ required: true, unique: true })
  channelId: string;

  @Prop({ type: Date, default: null })
  lastMessageAt: Date | null;

  @Prop({ type: String, default: null })
  lastMessagePreview: string | null;

  /** The last message's id and sender, for the chat list's read tick on your own last message. */
  @Prop({ type: String, default: null })
  lastMessageId: string | null;

  @Prop({ type: String, default: null })
  lastMessageSenderId: string | null;

  @Prop({ type: Number, default: 0 })
  memberCount: number;
}

export const ChatStateSchema = SchemaFactory.createForClass(ChatState);
ChatStateSchema.index({ lastMessageAt: -1 });
