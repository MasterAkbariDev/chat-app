import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { ChatType } from "src/enum/base.enum";

export interface ChatFolderFilters {
  includeTypes: ChatType[];
  includeTags: string[];
  includeChannelIds: string[];
  excludeChannelIds: string[];
  onlyUnread: boolean;
}

/**
 * B6 (docs/plans/BACKEND_PLAN.md) — Telegram-style chat folders. Applied server-side inside
 * `ChannelsService.listMine`'s single aggregation, not as a separate query.
 *
 * `filters` is a plain object-literal `@Prop({type: {...}})`, the same pattern already proven
 * safe in this codebase for `Message.forwardFrom`/`replySnapshot` — a decorated nested-class
 * sub-schema (`@Schema()` on a second class) hit a real bug here (see message.schema.ts's
 * `replySnapshot` history: a field literally named `type` collided with Mongoose's own
 * schema-type-detection key and broke schema construction), so this project sticks to the
 * literal-object form for embedded documents.
 */
@Schema({ collection: "chat_folders", timestamps: true, versionKey: false })
export class ChatFolder {
  _id: Types.ObjectId;

  @Prop({ required: true, type: String })
  ownerId: string;

  @Prop({ required: true, type: String, trim: true, maxlength: 50 })
  name: string;

  @Prop({ type: Number, default: 0 })
  order: number;

  @Prop({
    type: {
      includeTypes: { type: [String], default: [] },
      includeTags: { type: [String], default: [] },
      includeChannelIds: { type: [String], default: [] },
      excludeChannelIds: { type: [String], default: [] },
      onlyUnread: { type: Boolean, default: false },
      _id: false,
    },
    default: {},
  })
  filters: ChatFolderFilters;

  createdAt: Date;
  updatedAt: Date;
}

export const ChatFolderSchema = SchemaFactory.createForClass(ChatFolder);
ChatFolderSchema.index({ ownerId: 1, order: 1 });
