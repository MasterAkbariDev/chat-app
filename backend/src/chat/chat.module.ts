import { Module, forwardRef } from "@nestjs/common";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { MongooseModule } from "@nestjs/mongoose";
import { Chat, ChatSchema } from "./schema/chat.schema";
import { ChatMembers, ChatMembersSchema } from "./schema/chat-members.schema";
import { ChatState, ChatStateSchema } from "./schema/chat-state.schema";
import { User, UserSchema } from "../user/schema/user.schema";
import { GatewayModule } from "src/gateway/gateway.module";
import { Message, MessageSchema } from "../message/schema/message.schema";
import { ChatStateListener } from "./chat-state.listener";
import { PrivacyModule } from "src/privacy/privacy.module";

@Module({
  imports: [
    PrivacyModule,
    forwardRef(() => GatewayModule),
    MongooseModule.forFeature([
      { name: Chat.name, schema: ChatSchema },
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: ChatState.name, schema: ChatStateSchema },
      { name: User.name, schema: UserSchema },
      { name: Message.name, schema: MessageSchema },
    ]),
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatStateListener],
  exports: [],
})
export class ChatModule {}
