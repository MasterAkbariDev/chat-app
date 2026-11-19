import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { PushToken, PushTokenSchema } from "./schema/push-token.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { GatewayModule } from "src/gateway/gateway.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationService } from "./notification.service";
import { FcmService } from "./fcm.service";
import { PushQueueService } from "./push-queue.service";
import { PendingPush, PendingPushSchema } from "./schema/pending-push.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PushToken.name, schema: PushTokenSchema },
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: User.name, schema: UserSchema },
      { name: PendingPush.name, schema: PendingPushSchema },
    ]),
    GatewayModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationService, FcmService, PushQueueService],
})
export class NotificationsModule {}
