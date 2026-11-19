import { Module, forwardRef } from "@nestjs/common";
import { MessageController } from "./message.controller";
import { MessageService } from "./message.service";
import { MongooseModule } from "@nestjs/mongoose";
import { Message, MessageSchema } from "./schema/message.schema";
import {
  MessageReaction,
  MessageReactionSchema,
} from "./schema/message-reaction.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { ChatState, ChatStateSchema } from "src/chat/schema/chat-state.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import {
  MediaAsset,
  MediaAssetSchema,
} from "src/media/schema/media-asset.schema";
import {
  ReadCheckpoint,
  ReadCheckpointSchema,
} from "./schema/read-checkpoint.schema";
import { Block, BlockSchema } from "src/user/schema/block.schema";
import { MessageInfoService } from "./message-info.service";
import { GatewayModule } from "src/gateway/gateway.module";
import { PacksModule } from "src/packs/packs.module";
import { PrivacyModule } from "src/privacy/privacy.module";

@Module({
  imports: [
    PrivacyModule,
    forwardRef(() => GatewayModule),
    // For resolving + authorizing a sticker/animated-emoji reaction (toggleReaction) and a
    // sticker/animated-emoji message's packItemId (create) — see PacksService.resolveItemForUse.
    // No cycle: packs/ never imports from message/.
    PacksModule,
    MongooseModule.forFeature([
      { name: Message.name, schema: MessageSchema },
      { name: MessageReaction.name, schema: MessageReactionSchema },
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: ChatState.name, schema: ChatStateSchema },
      { name: User.name, schema: UserSchema },
      { name: MediaAsset.name, schema: MediaAssetSchema },
      { name: ReadCheckpoint.name, schema: ReadCheckpointSchema },
      { name: Block.name, schema: BlockSchema },
    ]),
  ],
  controllers: [MessageController],
  providers: [MessageService, MessageInfoService],
  exports: [MessageService],
})
export class MessageModule {}
