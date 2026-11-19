import { Module, forwardRef } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Report, ReportSchema } from "./schema/report.schema";
import {
  ModerationLog,
  ModerationLogSchema,
} from "./schema/moderation-log.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import { MessageModule } from "src/message/message.module";
import { GatewayModule } from "src/gateway/gateway.module";
import { TokenCacheModule } from "src/auth/token-cache.module";
import { ReportController } from "./report.controller";
import { AdminModerationController } from "./admin-moderation.controller";
import { ReportService } from "./report.service";
import { ModerationService } from "./moderation.service";
import { ModerationLogService } from "./moderation-log.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Report.name, schema: ReportSchema },
      { name: ModerationLog.name, schema: ModerationLogSchema },
      { name: User.name, schema: UserSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: Message.name, schema: MessageSchema },
    ]),
    MessageModule,
    forwardRef(() => GatewayModule),
    TokenCacheModule,
  ],
  controllers: [ReportController, AdminModerationController],
  providers: [ReportService, ModerationService, ModerationLogService],
  exports: [ModerationLogService, ModerationService],
})
export class ModerationModule {}
