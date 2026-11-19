import type { Connection, Model } from "mongoose";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Contact, ContactSchema } from "src/contacts/schema/contact.schema";
import { PrivacyService } from "src/privacy/privacy.service";

/** A real PrivacyService on a test connection (reuses models the spec already registered). */
export function privacyServiceFor(connection: Connection): PrivacyService {
  const users = (connection.models[User.name] ??
    connection.model(User.name, UserSchema)) as Model<User>;
  const contacts = (connection.models[Contact.name] ??
    connection.model(Contact.name, ContactSchema)) as Model<Contact>;
  return new PrivacyService(users, contacts);
}
