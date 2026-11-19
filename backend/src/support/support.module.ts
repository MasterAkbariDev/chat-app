import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuthModule } from "src/auth/auth.module";
import { ModerationModule } from "src/moderation/moderation.module";
import {
  SupportTicket,
  SupportTicketSchema,
} from "./schema/support-ticket.schema";
import { SupportController } from "./support.controller";
import { SupportService } from "./support.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SupportTicket.name, schema: SupportTicketSchema },
    ]),
    AuthModule,
    ModerationModule,
  ],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
