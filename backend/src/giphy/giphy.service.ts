import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { GiphyMedia } from "./schema/giphy-media.schema";
import {
  GiphyClientService,
  GiphyKind,
  GiphyItem,
} from "./giphy-client.service";
import { MediaService } from "src/media/media.service";
import { MediaAsset } from "src/media/schema/media-asset.schema";

export interface GiphySearchHit extends GiphyItem {
  /** Set once this exact Giphy id has already been mirrored — the picker can show it as
   *  "cached" (no external round trip when it's actually sent). */
  cachedRelativePath: string | null;
}

export interface GiphyUseResult {
  relativePath: string;
  title: string;
}

@Injectable()
export class GiphyService {
  constructor(
    @InjectModel(GiphyMedia.name)
    private readonly giphyMediaModel: Model<GiphyMedia>,
    private readonly giphyClient: GiphyClientService,
    private readonly mediaService: MediaService,
  ) {}

  private async attachCacheStatus(
    items: GiphyItem[],
    kind: GiphyKind,
  ): Promise<GiphySearchHit[]> {
    if (!items.length) return [];
    const ids = items.map(i => i.id);
    const cached = await this.giphyMediaModel
      .find({ giphyId: { $in: ids }, kind })
      .populate("mediaAssetId")
      .lean()
      .exec();
    const byId = new Map(
      cached.map(c => [
        c.giphyId,
        this.mediaService.variantPath(
          c.mediaAssetId as unknown as MediaAsset,
          "original",
        ),
      ]),
    );
    return items.map(item => ({
      ...item,
      cachedRelativePath: byId.get(item.id) ?? null,
    }));
  }

  async search(
    kind: GiphyKind,
    query: string,
    limit = 24,
    offset = 0,
  ): Promise<GiphySearchHit[]> {
    const items = await this.giphyClient.search(kind, query, limit, offset);
    return this.attachCacheStatus(items, kind);
  }

  async trending(
    kind: GiphyKind,
    limit = 24,
    offset = 0,
  ): Promise<GiphySearchHit[]> {
    const items = await this.giphyClient.trending(kind, limit, offset);
    return this.attachCacheStatus(items, kind);
  }

  /**
   * Cache-on-first-use (B9): the first time anyone sends a given Giphy id, mirror it into our
   * own `MediaService` storage and remember the mapping; every later use of that same id is
   * served from `giphy_media` alone — no Giphy call, and it keeps working even if Giphy is
   * unreachable. `ownerId` is whichever user triggers the first mirror (matches how a personal
   * upload's quota is charged) — everyone after them hits the cache for free.
   */
  async useGiphyAsset(
    kind: GiphyKind,
    giphyId: string,
    ownerId: string,
  ): Promise<GiphyUseResult> {
    const existing = await this.giphyMediaModel
      .findOne({ giphyId, kind })
      .populate("mediaAssetId")
      .exec();
    if (existing) {
      existing.usageCount += 1;
      existing.lastUsedAt = new Date();
      await existing.save();
      return {
        relativePath: this.mediaService.variantPath(
          existing.mediaAssetId as unknown as MediaAsset,
          "original",
        ),
        title: existing.title,
      };
    }

    const item = await this.giphyClient.getById(kind, giphyId);
    if (!item.originalUrl) {
      throw new NotFoundException("Giphy asset not found");
    }
    const buffer = await this.giphyClient.fetchBytes(item.originalUrl);
    const asset = await this.mediaService.ingestImage(buffer, ownerId);

    await this.giphyMediaModel.create({
      giphyId,
      kind,
      mediaAssetId: (asset as unknown as { _id: unknown })._id,
      title: item.title,
      usageCount: 1,
      lastUsedAt: new Date(),
    });

    return {
      relativePath: this.mediaService.variantPath(asset, "original"),
      title: item.title,
    };
  }
}
