import { Module, forwardRef } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Wallpaper, WallpaperSchema } from "./schema/wallpaper.schema";
import { WallpaperController } from "./wallpaper.controller";
import { WallpaperService } from "./wallpaper.service";
import { WallpaperMediaService } from "./wallpaper-media.service";
import { WallpaperGcService } from "./wallpaper-gc.service";
import { User, UserSchema } from "src/user/schema/user.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import {
  MediaAsset,
  MediaAssetSchema,
} from "src/media/schema/media-asset.schema";
import { MediaModule } from "src/media/media.module";
import { GatewayModule } from "src/gateway/gateway.module";

@Module({
  imports: [
    forwardRef(() => GatewayModule),
    MongooseModule.forFeature([
      { name: Wallpaper.name, schema: WallpaperSchema },
      { name: User.name, schema: UserSchema },
      { name: ChatMembers.name, schema: ChatMembersSchema },
      { name: Chat.name, schema: ChatSchema },
      { name: Message.name, schema: MessageSchema },
      { name: MediaAsset.name, schema: MediaAssetSchema },
    ]),
    MediaModule,
  ],
  controllers: [WallpaperController],
  providers: [WallpaperService, WallpaperMediaService, WallpaperGcService],
  exports: [WallpaperService],
})
export class WallpaperModule {}
