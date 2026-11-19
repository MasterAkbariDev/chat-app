import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { User } from "src/user/schema/user.schema";
import { Block } from "src/user/schema/block.schema";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Session } from "src/auth/schema/session.schema";
import { Clip } from "src/clips/schema/clip.schema";
import { Pack } from "src/packs/schema/pack.schema";
import { PackItem } from "src/packs/schema/pack-item.schema";
import { PackSubscription } from "src/packs/schema/pack-subscription.schema";
import { Wallpaper } from "src/wallpaper/schema/wallpaper.schema";
import { MediaService } from "src/media/media.service";
import { TokenCacheService } from "src/auth/token-cache.service";
import { comparePassword } from "src/utils/hash.util";

/**
 * Account deletion: re-auth + a cleanup job (B4, docs/plans/BACKEND_PLAN.md — "memberships,
 * blocks, orphan media refcount, anonymise authored messages to 'Deleted user'"). A dedicated
 * service (not folded into `UserService`) because it needs direct model access across five
 * modules' schemas for what is fundamentally one wide, one-shot operation — the per-module
 * services' own methods carry ownership/business-rule checks that don't apply here.
 *
 * "Anonymise authored messages" is done without touching a single `messages` row: every message
 * read already `.populate("senderId", "username firstName lastName image")` live off the
 * `User` document (see message.service.ts) — so overwriting those fields on the User doc itself
 * makes every message they ever sent display as "Deleted User" retroactively, for free.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Block.name) private blockModel: Model<Block>,
    @InjectModel(ChatMembers.name) private chatMembersModel: Model<ChatMembers>,
    @InjectModel(Session.name) private sessionModel: Model<Session>,
    @InjectModel(Clip.name) private clipModel: Model<Clip>,
    @InjectModel(Pack.name) private packModel: Model<Pack>,
    @InjectModel(PackItem.name) private packItemModel: Model<PackItem>,
    @InjectModel(PackSubscription.name)
    private packSubscriptionModel: Model<PackSubscription>,
    @InjectModel(Wallpaper.name) private wallpaperModel: Model<Wallpaper>,
    private mediaService: MediaService,
    private tokenCache: TokenCacheService,
  ) {}

  /** Releases every MediaAsset reference this user's clips/packs/wallpapers held, then
   *  deletes those rows — "orphan media refcount" (B4). Deleting the bookkeeping row outright
   *  here (rather than leaving it for a GC sweep, unlike wallpaper resets) is safe: nothing else
   *  can still be pointing at a clip/pack/wallpaper whose *owner* no longer exists. */
  private async releaseOwnedMedia(userId: string): Promise<void> {
    const ownerId = new Types.ObjectId(userId);

    const clips = await this.clipModel
      .find({ ownerId })
      .select("mediaId")
      .lean()
      .exec();
    for (const clip of clips) {
      await this.mediaService.release(clip.mediaId.toString());
    }
    await this.clipModel.deleteMany({ ownerId }).exec();

    const packs = await this.packModel
      .find({ ownerId })
      .select("_id")
      .lean()
      .exec();
    for (const pack of packs) {
      const items = await this.packItemModel
        .find({ packId: pack._id })
        .select("mediaId")
        .lean()
        .exec();
      for (const item of items) {
        await this.mediaService.release(item.mediaId.toString());
      }
      await this.packItemModel.deleteMany({ packId: pack._id }).exec();
      await this.packSubscriptionModel.deleteMany({ packId: pack._id }).exec();
    }
    await this.packModel.deleteMany({ ownerId }).exec();
    // Packs this user merely *added* (didn't own) — just drop their own subscription rows.
    await this.packSubscriptionModel.deleteMany({ userId }).exec();

    const wallpapers = await this.wallpaperModel
      .find({ ownerId })
      .select("mediaId")
      .lean()
      .exec();
    for (const wp of wallpapers) {
      if (wp.mediaId) await this.mediaService.release(wp.mediaId.toString());
    }
    await this.wallpaperModel.deleteMany({ ownerId }).exec();
  }

  async deleteAccount(
    userId: string,
    password: string,
  ): Promise<{ success: true }> {
    const user = await this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select("password")
      .exec();
    if (!user?.password) {
      throw new BadRequestException("User not found");
    }
    const valid = await comparePassword(password, user.password);
    if (!valid) {
      throw new UnauthorizedException("Incorrect password");
    }

    // Memberships: leave every chat/group/channel.
    await this.chatMembersModel.deleteMany({ userId }).exec();
    // Blocks: both directions.
    await this.blockModel
      .deleteMany({
        $or: [
          { blockerId: new Types.ObjectId(userId) },
          { blockedId: new Types.ObjectId(userId) },
        ],
      })
      .exec();
    // Orphan media refcount.
    await this.releaseOwnedMedia(userId);

    // Anonymise + soft-delete. Username/email get a stable-but-unique placeholder so the
    // unique/sparse indexes on both fields never collide, including across repeated deletions.
    const placeholder = `deleted_${userId}`;
    await this.userModel
      .updateOne(
        { _id: userId },
        {
          $set: {
            isDeleted: true,
            firstName: "Deleted",
            lastName: "User",
            username: placeholder,
            email: `${placeholder}@deleted.invalid`,
            phoneNumber: "",
            bio: "",
            image: [],
            globalWallpaperId: null,
          },
          $inc: { tokenVersion: 1 },
        },
      )
      .exec();

    // Log out everywhere.
    await this.tokenCache.invalidate(userId);
    await this.sessionModel
      .updateMany(
        { userId: new Types.ObjectId(userId), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
      .exec();

    return { success: true };
  }
}
