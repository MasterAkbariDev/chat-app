import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { ChannelsController } from "./channels.controller";
import { ChannelsService } from "./channels.service";
import { FoldersModule } from "src/folders/folders.module";
import { SearchModule } from "src/search/search.module";
import { PrivacyModule } from "src/privacy/privacy.module";
import { CallStateModule } from "src/calls/call-state.module";

@Module({
  imports: [
    PrivacyModule,
    CallStateModule,
    MongooseModule.forFeature([
      { name: ChatMembers.name, schema: ChatMembersSchema },
    ]),
    FoldersModule,
    SearchModule,
  ],
  controllers: [ChannelsController],
  providers: [ChannelsService],
})
export class ChannelsModule {}
