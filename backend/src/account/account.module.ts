import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Block, BlockSchema } from "src/user/schema/block.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Session, SessionSchema } from "src/auth/schema/session.schema";
import { Clip, ClipSchema } from "src/clips/schema/clip.schema";
import { Pack, PackSchema } from "src/packs/schema/pack.schema";
import { PackItem, PackItemSchema } from "src/packs/schema/pack-item.schema";
import {
  PackSubscription,
  PackSubscriptionSchema,
} from "src/packs/schema/pack-subscription.schema";
import {
  Wallpaper,
  WallpaperSchema,
} from "src/wallpaper/schema/wallpaper.schema";
import { MediaModule } from "src/media/media.module";
import { TokenCacheModule } from "src/auth/token-cache.module";
import { AccountController } from "./account.controller";
import { AccountDeletionService } from "./account-deletion.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Block.name, schema: BlockSchema },
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: Session.name, schema: SessionSchema },
      { name: Clip.name, schema: ClipSchema },
      { name: Pack.name, schema: PackSchema },
      { name: PackItem.name, schema: PackItemSchema },
      { name: PackSubscription.name, schema: PackSubscriptionSchema },
      { name: Wallpaper.name, schema: WallpaperSchema },
    ]),
    MediaModule,
    TokenCacheModule,
  ],
  controllers: [AccountController],
  providers: [AccountDeletionService],
})
export class AccountModule {}
