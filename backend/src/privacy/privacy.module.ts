import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Contact, ContactSchema } from "src/contacts/schema/contact.schema";
import { PrivacyService } from "./privacy.service";

/** Models only, so every module that serializes users can import it without cycles. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Contact.name, schema: ContactSchema },
    ]),
  ],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
