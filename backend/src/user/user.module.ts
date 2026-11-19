import { Module, forwardRef } from "@nestjs/common";
import { UserController } from "./user.controller";
import { UserService } from "./user.service";
import { MongooseModule } from "@nestjs/mongoose";
import { User, UserSchema } from "./schema/user.schema";
import { Block, BlockSchema } from "./schema/block.schema";
import { Contact, ContactSchema } from "src/contacts/schema/contact.schema";
import { GatewayModule } from "src/gateway/gateway.module";
import { PresenceModule } from "src/presence/presence.module";
import { TokenCacheModule } from "src/auth/token-cache.module";
import { PacksModule } from "src/packs/packs.module";
import { PeopleDiscoveryModule } from "./people-discovery.module";
import { PrivacyModule } from "src/privacy/privacy.module";
@Module({
  imports: [
    forwardRef(() => GatewayModule),
    PresenceModule,
    TokenCacheModule,
    PacksModule,
    PeopleDiscoveryModule,
    PrivacyModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Block.name, schema: BlockSchema },
      { name: Contact.name, schema: ContactSchema },
    ]),
  ],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService, MongooseModule],
})
export class UserModule {}
