import { Module, forwardRef } from "@nestjs/common";
import { ChatGateway } from "./chat.gateway";
import { MessageModule } from "src/message/message.module";
import { AuthModule } from "src/auth/auth.module";
import { UserModule } from "src/user/user.module";
import { MongooseModule } from "@nestjs/mongoose";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { PresenceModule } from "src/presence/presence.module";
import { PrivacyModule } from "src/privacy/privacy.module";

@Module({
  imports: [
    PrivacyModule,
    MessageModule,
    forwardRef(() => AuthModule),
    forwardRef(() => UserModule),
    PresenceModule,
    MongooseModule.forFeature([
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class GatewayModule {}
