import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { HydratedDocument, Model, Types } from "mongoose";
import { randomBytes } from "crypto";
import { Pack } from "./schema/pack.schema";
import { PackItem } from "./schema/pack-item.schema";
import { PackSubscription } from "./schema/pack-subscription.schema";
import { CreatePackDto } from "./dto/create-pack.dto";
import { UpdatePackDto } from "./dto/update-pack.dto";
import { MediaService } from "src/media/media.service";
import { MediaAsset } from "src/media/schema/media-asset.schema";
import { PackType } from "src/enum/base.enum";
import { escapeRegex } from "src/common/utils/escape-regex";

export interface PackItemView {
  id: string;
  /** The uploaded original — for big displays (a sent sticker). */
  relativePath: string;
  /** 160px variant, animation kept — for grids, inline emoji, reactions. */
  thumbPath: string;
  /** 160px first frame — shown when the viewer turned animation off. */
  stillPath: string;
  /** Whether the item has more than one frame. */
  animated: boolean;
  /** Pixel size of the original (null when unknown) — for aspect-correct sticker boxes. */
  width: number | null;
  height: number | null;
  keywords: string[];
  usageCount: number;
}

/** Display paths for a pack item's media (falls back to the original when
 *  variants couldn't be made). */
export interface PackItemMedia {
  relativePath: string;
  thumbPath: string;
  stillPath: string;
  animated: boolean;
  /** The original's pixel size — stickers come in any aspect ratio; null when unknown. */
  width: number | null;
  height: number | null;
  mediaId?: string;
}

export interface PackSummaryView {
  id: string;
  type: PackType;
  name: string;
  description: string | null;
  ownerId: string;
  slug: string;
  tags: string[];
  isPublic: boolean;
  itemCount: number;
  totalUsageCount: number;
  isOwner: boolean;
  isSubscribed: boolean;
}

export interface PackDetailView extends PackSummaryView {
  items: PackItemView[];
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base.slice(0, 40) : "pack";
}

@Injectable()
export class PacksService {
  constructor(
    @InjectModel(Pack.name) private readonly packModel: Model<Pack>,
    @InjectModel(PackItem.name)
    private readonly packItemModel: Model<PackItem>,
    @InjectModel(PackSubscription.name)
    private readonly packSubscriptionModel: Model<PackSubscription>,
    private readonly mediaService: MediaService,
  ) {}

  /** Assets whose variants are being generated in the background. */
  private readonly backfilling = new Set<string>();

  /** Returns every display path for an item. Items uploaded before small
   *  variants existed get them generated in the background (once — in-flight
   *  work is deduped); until then they're served from the original, so a
   *  read never waits seconds on image processing. Pass `wait` to block
   *  instead (fresh uploads, so the owner immediately sees the small ones). */
  private async itemMedia(
    assetRef: unknown,
    wait = false,
  ): Promise<PackItemMedia> {
    let asset = assetRef as (MediaAsset & { _id: Types.ObjectId }) | null;
    if (!asset || typeof asset !== "object" || !("variants" in asset)) {
      return {
        relativePath: "",
        thumbPath: "",
        stillPath: "",
        animated: false,
        width: null,
        height: null,
      };
    }
    if (!MediaService.hasCurrentPackVariants(asset)) {
      if (wait) {
        asset = await this.mediaService.ensurePackVariants(asset);
      } else {
        const key = String(asset._id);
        if (!this.backfilling.has(key)) {
          this.backfilling.add(key);
          void this.mediaService
            .ensurePackVariants(asset)
            .finally(() => this.backfilling.delete(key));
        }
      }
    }
    const relativePath = this.mediaService.variantPath(asset, "original");
    const thumbPath = asset.variants.packThumb ?? relativePath;
    const stillPath = asset.variants.packStill ?? thumbPath;
    return {
      relativePath,
      thumbPath,
      stillPath,
      animated: stillPath !== thumbPath,
      width: asset.width ?? null,
      height: asset.height ?? null,
      mediaId: String(asset._id),
    };
  }

  private async generateUniqueSlug(
    requested: string | undefined,
    name: string,
  ): Promise<string> {
    const candidateBase = requested ? slugify(requested) : slugify(name);
    let candidate = candidateBase;
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await this.packModel.exists({ slug: candidate }).exec();
      if (!exists) return candidate;
      candidate = `${candidateBase}-${randomBytes(3).toString("hex")}`;
    }
    // Astronomically unlikely to still collide — fall back to a fully random slug.
    return `pack-${randomBytes(6).toString("hex")}`;
  }

  private async toSummary(
    pack: Pack & { _id: Types.ObjectId },
    userId: string | undefined,
  ): Promise<PackSummaryView> {
    const isOwner = userId !== undefined && pack.ownerId.toString() === userId;
    // Deliberately not shortcut by `isOwner`: an owner can unsubscribe from their own pack
    // (see `unsubscribe`'s doc comment) and this should reflect that, same as anyone else.
    const isSubscribed =
      userId !== undefined &&
      (await this.packSubscriptionModel
        .exists({ userId, packId: pack._id })
        .exec()) !== null;
    return {
      id: pack._id.toString(),
      type: pack.type,
      name: pack.name,
      description: pack.description,
      ownerId: pack.ownerId.toString(),
      slug: pack.slug,
      tags: pack.tags,
      isPublic: pack.isPublic,
      itemCount: pack.itemCount,
      totalUsageCount: pack.totalUsageCount,
      isOwner,
      isSubscribed,
    };
  }

  async create(dto: CreatePackDto, ownerId: string): Promise<PackSummaryView> {
    const slug = await this.generateUniqueSlug(dto.slug, dto.name);
    const pack = await this.packModel.create({
      type: dto.type,
      name: dto.name,
      description: dto.description ?? null,
      tags: dto.tags ?? [],
      isPublic: dto.isPublic ?? false,
      slug,
      ownerId: new Types.ObjectId(ownerId),
    });
    // Owning a pack always implies having it — see class doc comment on PackSubscription.
    await this.packSubscriptionModel.create({
      userId: ownerId,
      packId: pack._id,
      order: 0,
    });
    return this.toSummary(pack, ownerId);
  }

  /** "My packs" — always exactly the caller's subscriptions, owned or added, in saved order. */
  async listMine(userId: string, type?: PackType): Promise<PackSummaryView[]> {
    const subs = await this.packSubscriptionModel
      .find({ userId })
      .sort({ order: 1, createdAt: 1 })
      .lean()
      .exec();
    if (!subs.length) return [];

    const packFilter: Record<string, unknown> = {
      _id: { $in: subs.map(s => s.packId) },
      isDeleted: false,
    };
    if (type) packFilter.type = type;

    const packs = await this.packModel.find(packFilter).lean().exec();
    const orderById = new Map(subs.map(s => [s.packId.toString(), s.order]));
    const views = await Promise.all(
      packs.map(p =>
        this.toSummary(p as Pack & { _id: Types.ObjectId }, userId),
      ),
    );
    return views.sort(
      (a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0),
    );
  }

  /** Public pack discovery — matches the `isPublic` discoverability rule (see Pack schema). */
  async search(
    query: string,
    type?: PackType,
    userId?: string,
    limit = 20,
    offset = 0,
  ): Promise<PackSummaryView[]> {
    const filter: Record<string, unknown> = {
      isDeleted: false,
      isPublic: true,
      $or: [
        { name: { $regex: escapeRegex(query), $options: "i" } },
        { description: { $regex: escapeRegex(query), $options: "i" } },
        { tags: { $in: [new RegExp(escapeRegex(query), "i")] } },
      ],
    };
    if (type) filter.type = type;

    const packs = await this.packModel
      .find(filter)
      .sort({ totalUsageCount: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .skip(Math.max(offset, 0))
      .lean()
      .exec();
    return Promise.all(
      packs.map(p =>
        this.toSummary(p as Pack & { _id: Types.ObjectId }, userId),
      ),
    );
  }

  /**
   * Keyword search across the items in every pack the caller has (owned or subscribed) — the
   * live-typing "type 😂 to find a matching sticker/emoji" picker query. Deliberately scoped to
   * the caller's own collection, same as Telegram: typing an emoji only searches packs you
   * actually have installed, not the whole public catalog.
   */
  async searchMyItems(
    userId: string,
    keyword: string,
    type?: PackType,
    limit = 30,
  ): Promise<(PackItemView & { packId: string })[]> {
    const trimmed = keyword.trim();
    if (!trimmed) return [];

    const subs = await this.packSubscriptionModel
      .find({ userId })
      .select("packId")
      .lean()
      .exec();
    if (!subs.length) return [];

    const packFilter: Record<string, unknown> = {
      _id: { $in: subs.map(s => s.packId) },
      isDeleted: false,
    };
    if (type) packFilter.type = type;
    const packIds = await this.packModel
      .find(packFilter)
      .select("_id")
      .lean()
      .exec();
    if (!packIds.length) return [];

    const items = await this.packItemModel
      .find({
        packId: { $in: packIds.map(p => p._id) },
        keywords: trimmed,
      })
      .populate("mediaId")
      .sort({ usageCount: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .lean()
      .exec();

    return Promise.all(
      items.map(async i => ({
        packId: i.packId.toString(),
        id: i._id.toString(),
        ...(await this.itemMedia(i.mediaId)),
        keywords: i.keywords,
        usageCount: i.usageCount,
      })),
    );
  }

  private async loadAccessiblePack(
    packId: string,
  ): Promise<Pack & { _id: Types.ObjectId }> {
    if (!Types.ObjectId.isValid(packId)) {
      throw new BadRequestException("Invalid pack id");
    }
    const pack = await this.packModel
      .findOne({ _id: packId, isDeleted: false })
      .lean()
      .exec();
    if (!pack) throw new NotFoundException("Pack not found");
    // No visibility gate here on purpose — see Pack schema's doc comment: `isPublic` is
    // discoverability only, not access. Anyone holding the id/slug can view+add it.
    return pack;
  }

  private async detailOf(
    pack: Pack & { _id: Types.ObjectId },
    userId: string | undefined,
  ): Promise<PackDetailView> {
    const items = await this.packItemModel
      .find({ packId: pack._id })
      .populate("mediaId")
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    const summary = await this.toSummary(pack, userId);
    return {
      ...summary,
      items: await Promise.all(
        items.map(async i => ({
          id: i._id.toString(),
          ...(await this.itemMedia(i.mediaId)),
          keywords: i.keywords,
          usageCount: i.usageCount,
        })),
      ),
    };
  }

  async findOne(packId: string, userId?: string): Promise<PackDetailView> {
    const pack = await this.loadAccessiblePack(packId);
    return this.detailOf(pack, userId);
  }

  async findBySlug(slug: string, userId?: string): Promise<PackDetailView> {
    const pack = await this.packModel
      .findOne({ slug, isDeleted: false })
      .lean()
      .exec();
    if (!pack) throw new NotFoundException("Pack not found");
    return this.detailOf(pack, userId);
  }

  private async requireOwnedPack(
    packId: string,
    userId: string,
  ): Promise<HydratedDocument<Pack>> {
    if (!Types.ObjectId.isValid(packId)) {
      throw new BadRequestException("Invalid pack id");
    }
    const pack = await this.packModel
      .findOne({ _id: packId, isDeleted: false })
      .exec();
    if (!pack) throw new NotFoundException("Pack not found");
    if (pack.ownerId.toString() !== userId) {
      throw new ForbiddenException("You can only modify your own packs");
    }
    return pack;
  }

  async updatePack(
    packId: string,
    dto: UpdatePackDto,
    userId: string,
  ): Promise<PackSummaryView> {
    const pack = await this.requireOwnedPack(packId, userId);
    if (dto.name !== undefined) pack.name = dto.name;
    if (dto.description !== undefined) pack.description = dto.description;
    if (dto.tags !== undefined) pack.tags = dto.tags;
    if (dto.isPublic !== undefined) pack.isPublic = dto.isPublic;
    await pack.save();
    return this.toSummary(pack, userId);
  }

  /**
   * Soft-deletes the pack and releases every item's `MediaAsset` reference (same "archive, don't
   * delete the media" philosophy as B11's orphan sweep — deleting the pack row is enough; the
   * underlying media rows/files are cleaned up by that existing sweep once `refCount` hits 0).
   * Every subscriber (not just the owner) loses it from their "my packs" list.
   */
  async deletePack(packId: string, userId: string): Promise<{ deleted: true }> {
    const pack = await this.requireOwnedPack(packId, userId);
    const items = await this.packItemModel
      .find({ packId: pack._id })
      .select("mediaId")
      .lean()
      .exec();
    await Promise.all(
      items.map(i => this.mediaService.release(i.mediaId.toString())),
    );
    await this.packItemModel.deleteMany({ packId: pack._id }).exec();
    await this.packSubscriptionModel.deleteMany({ packId: pack._id }).exec();
    pack.isDeleted = true;
    await pack.save();
    return { deleted: true };
  }

  /** Real upload via `MediaService` (magic-byte sniffed, deduped, size-capped) — owner only. */
  async addItems(
    packId: string,
    files: Express.Multer.File[],
    keywords: string[] | undefined,
    ownerId: string,
  ): Promise<PackItemView[]> {
    if (!files?.length) {
      throw new BadRequestException("At least one file is required");
    }
    const pack = await this.requireOwnedPack(packId, ownerId);

    const created: PackItemView[] = [];
    for (const file of files) {
      const asset = await this.mediaService.ingestImage(file.buffer, ownerId);
      const item = await this.packItemModel.create({
        packId: pack._id,
        mediaId: asset._id,
        keywords: keywords ?? [],
      });
      created.push({
        id: item._id.toString(),
        ...(await this.itemMedia(asset, true)),
        keywords: item.keywords,
        usageCount: 0,
      });
    }
    await this.packModel
      .updateOne({ _id: pack._id }, { $inc: { itemCount: files.length } })
      .exec();
    return created;
  }

  async updateItem(
    packId: string,
    itemId: string,
    dto: { keywords: string[] },
    ownerId: string,
  ): Promise<PackItemView> {
    await this.requireOwnedPack(packId, ownerId);
    if (!Types.ObjectId.isValid(itemId)) {
      throw new BadRequestException("Invalid item id");
    }
    const item = await this.packItemModel
      .findOneAndUpdate(
        { _id: itemId, packId: new Types.ObjectId(packId) },
        { $set: { keywords: dto.keywords } },
        { new: true },
      )
      .populate("mediaId")
      .exec();
    if (!item) throw new NotFoundException("Item not found in this pack");
    return {
      id: item._id.toString(),
      ...(await this.itemMedia(item.mediaId)),
      keywords: item.keywords,
      usageCount: item.usageCount,
    };
  }

  async removeItem(
    packId: string,
    itemId: string,
    ownerId: string,
  ): Promise<{ removed: true }> {
    const pack = await this.requireOwnedPack(packId, ownerId);
    if (!Types.ObjectId.isValid(itemId)) {
      throw new BadRequestException("Invalid item id");
    }
    const item = await this.packItemModel
      .findOneAndDelete({ _id: itemId, packId: pack._id })
      .exec();
    if (!item) throw new NotFoundException("Item not found in this pack");
    await this.mediaService.release(item.mediaId.toString());
    await this.packModel
      .updateOne({ _id: pack._id }, { $inc: { itemCount: -1 } })
      .exec();
    return { removed: true };
  }

  /** Add this pack to my own collection ("Add" in the tap-preview modal, or after opening a link). */
  async subscribe(packId: string, userId: string): Promise<{ ok: true }> {
    const pack = await this.loadAccessiblePack(packId);
    try {
      // After the current last one — a count would collide with existing slots once
      // something has been removed or reordered.
      const last = await this.packSubscriptionModel
        .findOne({ userId })
        .sort({ order: -1 })
        .select("order")
        .lean()
        .exec();
      await this.packSubscriptionModel.create({
        userId,
        packId: pack._id,
        order: (last?.order ?? -1) + 1,
      });
    } catch (err: unknown) {
      // Already subscribed (unique index race or repeat tap) — same end state, not an error.
      if ((err as { code?: number })?.code !== 11000) throw err;
    }
    return { ok: true };
  }

  /**
   * Reorders "my packs". `packIds` is the new order of some of my packs (typically one
   * type's list); they're redistributed over the order slots they already occupy, so the
   * other type's packs keep their places. Ids I don't have are ignored.
   */
  async reorderMine(userId: string, packIds: string[]): Promise<{ ok: true }> {
    if (!Array.isArray(packIds) || packIds.length > 500) {
      throw new BadRequestException("packIds must be a list of pack ids");
    }
    const subs = await this.packSubscriptionModel
      .find({ userId })
      .sort({ order: 1, createdAt: 1 })
      .lean()
      .exec();
    // Normalize first so every subscription has a distinct slot (older data may share 0s).
    const slotOf = new Map(subs.map((s, i) => [s.packId.toString(), i]));
    const wanted = [...new Set(packIds)].filter(id => slotOf.has(id));
    const slots = wanted.map(id => slotOf.get(id)!).sort((a, b) => a - b);
    wanted.forEach((id, i) => slotOf.set(id, slots[i]));
    await this.packSubscriptionModel.bulkWrite(
      subs.map(s => ({
        updateOne: {
          filter: { _id: s._id },
          update: { $set: { order: slotOf.get(s.packId.toString())! } },
        },
      })),
    );
    return { ok: true };
  }

  /**
   * Remove this pack from my own collection. Allowed for the owner too (Telegram's own
   * behavior — the pack stays published, you just stop seeing it in your own picker); use
   * `deletePack` to actually take a pack down.
   */
  async unsubscribe(packId: string, userId: string): Promise<{ ok: true }> {
    if (!Types.ObjectId.isValid(packId)) {
      throw new BadRequestException("Invalid pack id");
    }
    await this.packSubscriptionModel
      .deleteOne({ userId, packId: new Types.ObjectId(packId) })
      .exec();
    return { ok: true };
  }

  /** Bumps the item's + pack's denormalized usage — only for someone who actually has the pack. */
  async useItem(
    packId: string,
    itemId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    if (!Types.ObjectId.isValid(packId) || !Types.ObjectId.isValid(itemId)) {
      throw new BadRequestException("Invalid id");
    }
    const pack = await this.packModel
      .findOne({ _id: packId, isDeleted: false })
      .lean()
      .exec();
    if (!pack) throw new NotFoundException("Pack not found");

    const isOwner = pack.ownerId.toString() === userId;
    // Unlike `toSummary`'s display-only `isSubscribed` flag, an owner can always use their own
    // items even if they've personally unsubscribed from their own picker view — this is an
    // access-control gate, not a "what does the picker show" signal.
    const canUse =
      isOwner ||
      (await this.packSubscriptionModel
        .exists({ userId, packId: pack._id })
        .exec()) !== null;
    if (!canUse) {
      throw new ForbiddenException("Add this pack before using it");
    }

    const item = await this.packItemModel
      .findOneAndUpdate(
        { _id: itemId, packId: pack._id },
        { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } },
      )
      .exec();
    if (!item) throw new NotFoundException("Item not found in this pack");
    await this.packModel
      .updateOne({ _id: pack._id }, { $inc: { totalUsageCount: 1 } })
      .exec();
    return { ok: true };
  }

  /**
   * Resolves + authorizes a pack item for "use" beyond the dedicated `useItem` send flow —
   * currently two call sites: a message *reaction* (`MessageService.toggleReaction`) and a
   * sticker/animated-emoji *message*'s `packItemId` (`MessageService.create`, so a received
   * sticker can be traced back to its pack and tapped to open it — the "encountered a pack"
   * discovery path). Same access rule as `useItem` (owner or subscriber: "add this pack before
   * using it"), and bumps usage the same way, since both are a real "use" of the item just like
   * sending one via `useItem` itself. Returns just enough for the caller to denormalize onto its
   * own row (a message or a `message_reactions` row) without a read-time join.
   */
  /**
   * Same owner-or-subscriber access check as `resolveItemForUse`, but read-only (no usage
   * bump) — for *choosing* an item somewhere rather than sending it, e.g. picking an
   * animated emoji as your quick reaction (`UserService.updateQuickReaction`).
   */
  async describeUsableItem(
    itemId: string,
    userId: string,
  ): Promise<
    { packId: string; packType: PackType; keywords: string[] } & PackItemMedia
  > {
    if (!Types.ObjectId.isValid(itemId)) {
      throw new BadRequestException("Invalid item id");
    }
    const item = await this.packItemModel
      .findById(itemId)
      .populate("mediaId")
      .lean()
      .exec();
    if (!item) throw new NotFoundException("Item not found");
    const pack = await this.packModel
      .findOne({ _id: item.packId, isDeleted: false })
      .lean()
      .exec();
    if (!pack) throw new NotFoundException("Pack not found");
    const canUse =
      pack.ownerId.toString() === userId ||
      (await this.packSubscriptionModel
        .exists({ userId, packId: pack._id })
        .exec()) !== null;
    if (!canUse) throw new ForbiddenException("Add this pack before using it");
    return {
      packId: pack._id.toString(),
      packType: pack.type,
      keywords: item.keywords ?? [],
      ...(await this.itemMedia(item.mediaId)),
    };
  }

  async resolveItemForUse(
    itemId: string,
    userId: string,
  ): Promise<{ packId: string; packType: PackType } & PackItemMedia> {
    if (!Types.ObjectId.isValid(itemId)) {
      throw new BadRequestException("Invalid item id");
    }
    const item = await this.packItemModel
      .findById(itemId)
      .populate("mediaId")
      .lean()
      .exec();
    if (!item) throw new NotFoundException("Item not found");

    const pack = await this.packModel
      .findOne({ _id: item.packId, isDeleted: false })
      .lean()
      .exec();
    if (!pack) throw new NotFoundException("Pack not found");

    const isOwner = pack.ownerId.toString() === userId;
    const canUse =
      isOwner ||
      (await this.packSubscriptionModel
        .exists({ userId, packId: pack._id })
        .exec()) !== null;
    if (!canUse) {
      throw new ForbiddenException("Add this pack before using it");
    }

    await this.packItemModel
      .updateOne(
        { _id: item._id },
        { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } },
      )
      .exec();
    await this.packModel
      .updateOne({ _id: pack._id }, { $inc: { totalUsageCount: 1 } })
      .exec();

    return {
      packId: pack._id.toString(),
      ...(await this.itemMedia(item.mediaId)),
      packType: pack.type,
    };
  }
}
