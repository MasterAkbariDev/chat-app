import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Public } from "src/common/decorators/public.decorator";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { AdminJwtAuthGuard } from "src/admin/admin-jwt.guard";
import { MediaAsset } from "./schema/media-asset.schema";
import { MEDIA_STORAGE, MediaStorage } from "./storage/media-storage.interface";

/** `@Public()` at the class level only skips the *global* user `JwtAuthGuard` — every route
 *  re-applies `AdminJwtAuthGuard`, which requires a real admin-audience token. */
@ApiTags("Admin — Media")
@Controller({ path: "admin/media", version: "1" })
@Public()
@UseGuards(AdminJwtAuthGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class AdminMediaController {
  constructor(
    @InjectModel(MediaAsset.name) private mediaAssetModel: Model<MediaAsset>,
    @Inject(MEDIA_STORAGE) private storage: MediaStorage,
  ) {}

  @Get("orphans")
  @ApiOperation({
    summary: "List media assets at refCount 0",
    description:
      "Archived, never auto-deleted (B11 Q7) — surfaced here for an admin to review and " +
      "optionally hard-delete individually.",
  })
  listOrphans() {
    return this.mediaAssetModel
      .find({ refCount: { $lte: 0 } })
      .select("hash kind mimeType sizeBytes tier lastAccessedAt createdAt")
      .sort({ lastAccessedAt: 1 })
      .limit(200)
      .lean()
      .exec();
  }

  @Delete(":id")
  @ApiOperation({
    summary: "Hard-delete a refCount-0 media asset",
    description:
      "Only allowed when refCount is 0 — deletes the underlying files (every variant) and the " +
      "media_assets row. This is the only place anything in MediaService actually gets deleted.",
  })
  @ApiParam({ name: "id" })
  async hardDelete(@Param("id", ParseObjectIdPipe) id: string) {
    const asset = await this.mediaAssetModel.findById(id).exec();
    if (!asset) {
      throw new NotFoundException("Media asset not found");
    }
    if (asset.refCount > 0) {
      throw new BadRequestException(
        `Still referenced (refCount ${asset.refCount}) — cannot hard-delete`,
      );
    }
    await this.storage.deleteAll(asset.hash);
    await this.mediaAssetModel.deleteOne({ _id: id }).exec();
    return { success: true };
  }
}
