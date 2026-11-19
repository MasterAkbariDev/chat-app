import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Contact, ContactSchema } from "./schema/contact.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { ChatState, ChatStateSchema } from "src/chat/schema/chat-state.schema";
import { ContactsController } from "./contacts.controller";
import { ContactsService } from "./contacts.service";
import { PresenceModule } from "src/presence/presence.module";
import { PeopleDiscoveryModule } from "src/user/people-discovery.module";
import { PrivacyModule } from "src/privacy/privacy.module";

@Module({
  imports: [
    PrivacyModule,
    MongooseModule.forFeature([
      { name: Contact.name, schema: ContactSchema },
      { name: User.name, schema: UserSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: ChatState.name, schema: ChatStateSchema },
    ]),
    PresenceModule,
    PeopleDiscoveryModule,
  ],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
