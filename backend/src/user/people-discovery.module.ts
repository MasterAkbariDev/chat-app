import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { User, UserSchema } from "./schema/user.schema";
import { Block, BlockSchema } from "./schema/block.schema";
import { Contact, ContactSchema } from "src/contacts/schema/contact.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { PeopleDiscoveryService } from "./people-discovery.service";
import { PrivacyModule } from "src/privacy/privacy.module";

/** Dependency-free (models only) so search, users and contacts can all import it. */
@Module({
  imports: [
    PrivacyModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Block.name, schema: BlockSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: ChatMembers.name, schema: ChatMembersSchema },
    ]),
  ],
  providers: [PeopleDiscoveryService],
  exports: [PeopleDiscoveryService],
})
export class PeopleDiscoveryModule {}
