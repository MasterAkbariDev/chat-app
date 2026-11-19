import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Wallpaper } from "./schema/wallpaper.schema";
import { User } from "src/user/schema/user.schema";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { MediaAsset } from "src/media/schema/media-asset.schema";

export interface WallpaperGcResult {
  scanned: number;
  deleted: number;
}

/**
 * Nightly sweep of `Wallpaper` docs no longer referenced by any `user.globalWallpaperId` or
 * `chatMembers.chatWallpaperId` pointer (B9, docs/plans/BACKEND_PLAN.md — "nightly GC of
 * unreferenced wallpaper media"). Orphans accumulate because `resetGlobal`/`resetChat` only
 * clear the pointer — they can't delete the `Wallpaper` doc outright, since a different member
 * who `acceptShared`-ed the same doc may still be pointing at it. Only deletes the bookkeeping
 * row + releases its `MediaAsset` reference count; the underlying media file/row itself is an
 * explicit B11 concern (see `MediaService.release`).
 */
@Injectable()
export class WallpaperGcService {
  private readonly logger = new Logger(WallpaperGcService.name);

  constructor(
    @InjectModel(Wallpaper.name)
    private readonly wallpaperModel: Model<Wallpaper>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(ChatMembers.name)
    private readonly chatMembersModel: Model<ChatMembers>,
    @InjectModel(MediaAsset.name)
    private readonly mediaAssetModel: Model<MediaAsset>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runGc(): Promise<WallpaperGcResult> {
    const [globalIds, chatIds] = await Promise.all([
      this.userModel.distinct("globalWallpaperId", {
        globalWallpaperId: { $ne: null },
      }),
      this.chatMembersModel.distinct("chatWallpaperId", {
        chatWallpaperId: { $ne: null },
      }),
    ]);
    const referenced = new Set(
      [...globalIds, ...chatIds].map(id => id.toString()),
    );

    const all = await this.wallpaperModel
      .find()
      .select("_id mediaId")
      .lean()
      .exec();
    const orphans = all.filter(w => !referenced.has(w._id.toString()));

    for (const orphan of orphans) {
      if (orphan.mediaId) {
        await this.mediaAssetModel
          .updateOne(
            { _id: orphan.mediaId, refCount: { $gt: 0 } },
            { $inc: { refCount: -1 } },
          )
          .exec();
      }
    }
    if (orphans.length > 0) {
      await this.wallpaperModel
        .deleteMany({ _id: { $in: orphans.map(o => o._id) } })
        .exec();
    }

    const result: WallpaperGcResult = {
      scanned: all.length,
      deleted: orphans.length,
    };
    this.logger.log(
      `Wallpaper GC: scanned ${result.scanned}, deleted ${result.deleted} orphaned doc(s)`,
    );
    return result;
  }
}
