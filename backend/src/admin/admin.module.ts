import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AdminUser, AdminUserSchema } from "./schema/admin-user.schema";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";
import { AdminJwtStrategy } from "./admin-jwt.strategy";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersService } from "./admin-users.service";
import { AdminAuditController } from "./admin-audit.controller";
import { AdminAuditService } from "./admin-audit.service";
import { AdminRolesGuard } from "./admin-roles.guard";
import { AdminAccountsController } from "./admin-accounts.controller";
import { AdminAccountsService } from "./admin-accounts.service";
import { AdminRecoveryController } from "./admin-recovery.controller";
import { AdminRecoveryService } from "./admin-recovery.service";
import { AdminUserActionsController } from "./admin-user-actions.controller";
import { AdminUserActionsService } from "./admin-user-actions.service";
import { TokenCacheModule } from "src/auth/token-cache.module";
import { AdminSupportController } from "./admin-support.controller";
import { AdminSupportService } from "./admin-support.service";
import {
  SupportTicket,
  SupportTicketSchema,
} from "src/support/schema/support-ticket.schema";
import {
  RecoveryRequest,
  RecoveryRequestSchema,
} from "src/auth/schema/recovery-request.schema";
import {
  RecoveryToken,
  RecoveryTokenSchema,
} from "src/auth/schema/recovery-token.schema";
import { AuthModule } from "src/auth/auth.module";
import { ModerationModule } from "src/moderation/moderation.module";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Session, SessionSchema } from "src/auth/schema/session.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Report, ReportSchema } from "src/moderation/schema/report.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import {
  ModerationLog,
  ModerationLogSchema,
} from "src/moderation/schema/moderation-log.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AdminUser.name, schema: AdminUserSchema },
      { name: User.name, schema: UserSchema },
      { name: Session.name, schema: SessionSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: Report.name, schema: ReportSchema },
      { name: Message.name, schema: MessageSchema },
      { name: RecoveryRequest.name, schema: RecoveryRequestSchema },
      { name: RecoveryToken.name, schema: RecoveryTokenSchema },
      { name: SupportTicket.name, schema: SupportTicketSchema },
      { name: ModerationLog.name, schema: ModerationLogSchema },
    ]),
    AuthModule,
    ModerationModule,
    TokenCacheModule,
  ],
  controllers: [
    AdminAuthController,
    AdminUsersController,
    AdminAuditController,
    AdminAccountsController,
    AdminRecoveryController,
    AdminUserActionsController,
    AdminSupportController,
  ],
  providers: [
    AdminAuthService,
    AdminJwtStrategy,
    AdminRolesGuard,
    AdminUsersService,
    AdminAuditService,
    AdminAccountsService,
    AdminRecoveryService,
    AdminUserActionsService,
    AdminSupportService,
  ],
})
export class AdminModule {}
