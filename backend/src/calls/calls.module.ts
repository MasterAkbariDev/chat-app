import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Block, BlockSchema } from "src/user/schema/block.schema";
import { MessageModule } from "src/message/message.module";
import { GatewayModule } from "src/gateway/gateway.module";
import { CallsController } from "./calls.controller";
import { CallsService } from "./calls.service";
import { CallStateModule } from "./call-state.module";
import { LiveKitTokenService } from "./livekit-token.service";
import { PrivacyModule } from "src/privacy/privacy.module";

@Module({
  imports: [
    PrivacyModule,
    CallStateModule,
    MongooseModule.forFeature([
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: User.name, schema: UserSchema },
      { name: Block.name, schema: BlockSchema },
    ]),
    MessageModule,
    GatewayModule,
  ],
  controllers: [CallsController],
  providers: [CallsService, LiveKitTokenService],
})
export class CallsModule {}
