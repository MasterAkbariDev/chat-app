import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ClipsController } from "./clips.controller";
import { ClipsService } from "./clips.service";
import { GifConversionService } from "./gif-conversion.service";
import { Clip, ClipSchema } from "./schema/clip.schema";
import { MediaModule } from "src/media/media.module";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  MediaAsset,
  MediaAssetSchema,
} from "src/media/schema/media-asset.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Clip.name, schema: ClipSchema },
      // Read-only here: authorizing + resolving "save this GIF from a message".
      { name: Message.name, schema: MessageSchema },
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: MediaAsset.name, schema: MediaAssetSchema },
    ]),
    MediaModule,
  ],
  controllers: [ClipsController],
  providers: [ClipsService, GifConversionService],
  exports: [ClipsService],
})
export class ClipsModule {}
