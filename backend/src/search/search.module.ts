import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Block, BlockSchema } from "src/user/schema/block.schema";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";
import { PeopleDiscoveryModule } from "src/user/people-discovery.module";
import { PrivacyModule } from "src/privacy/privacy.module";

@Module({
  imports: [
    PrivacyModule,
    PeopleDiscoveryModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: Message.name, schema: MessageSchema },
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: Block.name, schema: BlockSchema },
    ]),
  ],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
