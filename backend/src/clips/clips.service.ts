import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, extname, join } from "path";
import { Clip } from "./schema/clip.schema";
import { GifConversionService } from "./gif-conversion.service";
import { MediaService } from "src/media/media.service";
import { MediaAsset } from "src/media/schema/media-asset.schema";
import { Message } from "src/message/schema/message.schema";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { MessageType } from "src/enum/base.enum";
import { sniffImageType } from "src/media/file-sniff.util";
import { sniffVideoType } from "src/media/video-sniff.util";

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi)$/i;
/** Largest legacy (pre-MediaService) GIF file we'll ingest when saving from a message. */
const LEGACY_GIF_MAX_BYTES = 8 * 1024 * 1024;
/** Uploaded GIFs up to this size are kept byte-for-byte (MediaService caps GIFs at 8 MB). */
const CLIP_GIF_PASSTHROUGH_BYTES = 8 * 1024 * 1024;

export interface ClipItem {
  id: string;
  mediaId: string;
  title: string;
  relativePath: string;
  lastUsedAt: string | null;
  usageCount: number;
}

@Injectable()
export class ClipsService {
  constructor(
    @InjectModel(Clip.name) private readonly clipModel: Model<Clip>,
    private readonly gifConversion: GifConversionService,
    private readonly mediaService: MediaService,
    @InjectModel(Message.name) private readonly messageModel: Model<Message>,
    @InjectModel(ChatMembers.name)
    private readonly chatMembersModel: Model<ChatMembers>,
    @InjectModel(Chat.name) private readonly chatModel: Model<Chat>,
    @InjectModel(MediaAsset.name)
    private readonly mediaAssetModel: Model<MediaAsset>,
  ) {}

  async list(ownerId: string, limit = 50, offset = 0): Promise<ClipItem[]> {
    const docs = await this.clipModel
      .find({ ownerId: new Types.ObjectId(ownerId) })
      .populate("mediaId")
      .sort({ lastUsedAt: -1, createdAt: -1 })
      .limit(limit)
      .skip(offset)
      .lean()
      .exec();
    return docs.map(d => this.toItem(d));
  }

  /**
   * Saves an uploaded file to the caller's personal library: a GIF is stored as-is, a short
   * video clip is converted to a looping GIF first.
   */
  async upload(
    file: Express.Multer.File,
    ownerId: string,
    title?: string,
  ): Promise<ClipItem> {
    if (!file) throw new BadRequestException("No file provided");
    const isGif = sniffImageType(file.buffer)?.ext === "gif";
    // A GIF small enough is stored as-is; a bigger one goes through the same palette pass as
    // a video (smaller, still looping) instead of being refused.
    if (isGif && file.buffer.length <= CLIP_GIF_PASSTHROUGH_BYTES) {
      const asset = await this.mediaService.ingestImage(file.buffer, ownerId);
      return this.saveAsset(ownerId, asset, title);
    }
    // Content first (a phone may hand over "blob" or a wrong extension), then the name.
    const sniffedExt = isGif ? "gif" : sniffVideoType(file.buffer)?.ext;
    const nameExt = extname(file.originalname ?? "").toLowerCase();
    const ext = sniffedExt
      ? `.${sniffedExt}`
      : VIDEO_EXT.test(nameExt)
        ? nameExt
        : null;
    if (!ext) {
      throw new BadRequestException(
        "Only GIFs and video files are allowed (gif, mp4, webm, mov, m4v, mkv, avi)",
      );
    }

    const tempDir = mkdtempSync(join(tmpdir(), "clip-upload-"));
    try {
      const inputPath = join(tempDir, `input${ext}`);
      const gifPath = join(tempDir, "output.gif");
      writeFileSync(inputPath, file.buffer);

      await this.gifConversion.convertVideoToGif(inputPath, gifPath);
      const gifBuffer = readFileSync(gifPath);
      const asset = await this.mediaService.ingestImage(gifBuffer, ownerId);
      return this.saveAsset(ownerId, asset, title);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Saves the GIF of a message the caller can see to their library, re-using the media that
   * is already stored for it (never re-downloaded). Works for MediaService media (by the
   * message's `attachmentMeta.mediaId`, or by the content hash in its `/uploads/media/<hash>/`
   * URL) and for migrated `/uploads/<file>.gif` links, which are read from local disk once
   * and ingested.
   */
  async saveFromMessage(messageId: string, ownerId: string): Promise<ClipItem> {
    if (!Types.ObjectId.isValid(messageId)) {
      throw new BadRequestException("Invalid message id");
    }
    const message = await this.messageModel
      .findById(messageId)
      .select("channelId type attachments attachmentMeta isDeleted deletedFor")
      .lean()
      .exec();
    if (
      !message ||
      message.isDeleted ||
      (message.deletedFor ?? []).some(id => String(id) === ownerId)
    ) {
      throw new NotFoundException("Message not found");
    }
    const isMember = await this.chatMembersModel
      .exists({ channelId: message.channelId, userId: ownerId })
      .exec();
    if (!isMember) {
      const isPublic = await this.chatModel
        .exists({ _id: message.channelId, isPublic: true, isDeleted: false })
        .exec();
      if (!isPublic) throw new ForbiddenException("Access denied");
    }

    const url = message.attachments?.[0];
    const isGif =
      message.type === MessageType.GIF ||
      (message.type === MessageType.IMAGE && !!url && /\.gif($|\?)/i.test(url));
    if (!url || !isGif) {
      throw new BadRequestException("Only GIF messages can be saved");
    }

    const meta = (
      message.attachmentMeta as Record<string, { mediaId?: string }> | null
    )?.[url];
    const byId =
      meta?.mediaId && Types.ObjectId.isValid(meta.mediaId)
        ? await this.mediaAssetModel.findById(meta.mediaId).exec()
        : null;
    if (byId) return this.saveAsset(ownerId, byId, undefined, false);
    const fromUrl = await this.assetFromUrl(url, ownerId);
    if (!fromUrl) {
      throw new BadRequestException("This GIF's file isn't available");
    }
    return this.saveAsset(ownerId, fromUrl, undefined, true);
  }

  /** `/uploads/media/<hash>/…` → that asset (retained); `/uploads/<file>.gif` → ingested. */
  private async assetFromUrl(
    url: string,
    ownerId: string,
  ): Promise<MediaAsset | null> {
    let path: string;
    try {
      path = new URL(url, "http://local").pathname;
    } catch {
      return null;
    }
    const idx = path.indexOf("/uploads/");
    if (idx < 0) return null;
    const rest = decodeURIComponent(path.slice(idx + "/uploads/".length));
    const media = /^media\/([a-f0-9]{64})\//.exec(rest);
    if (media) {
      const asset = await this.mediaAssetModel
        .findOne({ hash: media[1] })
        .exec();
      if (asset) await this.mediaService.retain(asset._id.toString());
      return asset;
    }
    // Migrated links are flat files: only a bare file name, nothing path-like.
    if (rest !== basename(rest) || !/\.gif$/i.test(rest)) return null;
    const roots = [
      join(process.cwd(), "uploads"),
      ...(process.env.LEGACY_UPLOADS_DIR
        ? [process.env.LEGACY_UPLOADS_DIR]
        : []),
    ];
    for (const root of roots) {
      const file = join(root, rest);
      if (!existsSync(file)) continue;
      if (statSync(file).size > LEGACY_GIF_MAX_BYTES) {
        throw new BadRequestException("This GIF is too large to save");
      }
      return this.mediaService.ingestImage(readFileSync(file), ownerId);
    }
    return null;
  }

  /**
   * Upserts the (owner, asset) library entry. `alreadyRetained`: the caller already holds a
   * reference for this save (ingestImage/retain both count one) — handed back when the clip
   * already existed, so re-saving never leaks a reference.
   */
  private async saveAsset(
    ownerId: string,
    asset: MediaAsset & { _id: Types.ObjectId },
    title?: string,
    alreadyRetained = true,
  ): Promise<ClipItem> {
    const owner = new Types.ObjectId(ownerId);
    const existing = await this.clipModel
      .exists({ ownerId: owner, mediaId: asset._id })
      .exec();
    if (existing && alreadyRetained) {
      await this.mediaService.release(asset._id.toString());
    } else if (!existing && !alreadyRetained) {
      await this.mediaService.retain(asset._id.toString());
    }
    const doc = await this.clipModel
      .findOneAndUpdate(
        { ownerId: owner, mediaId: asset._id },
        {
          $set: {
            lastUsedAt: new Date(),
            ...(title?.trim() ? { title: title.trim() } : {}),
          },
          $setOnInsert: { usageCount: 0 },
        },
        { upsert: true, new: true },
      )
      .exec();
    return this.toItem({ ...doc.toObject(), mediaId: asset });
  }

  async use(clipId: string, ownerId: string): Promise<{ ok: true }> {
    const doc = await this.requireOwnedClip(clipId, ownerId);
    doc.usageCount += 1;
    doc.lastUsedAt = new Date();
    await doc.save();
    return { ok: true };
  }

  async remove(clipId: string, ownerId: string): Promise<{ removed: true }> {
    const doc = await this.requireOwnedClip(clipId, ownerId);
    await this.clipModel.deleteOne({ _id: doc._id }).exec();
    await this.mediaService.release(doc.mediaId.toString());
    return { removed: true };
  }

  private async requireOwnedClip(clipId: string, ownerId: string) {
    if (!Types.ObjectId.isValid(clipId)) {
      throw new BadRequestException("Invalid clip id");
    }
    const doc = await this.clipModel.findById(clipId).exec();
    if (!doc) throw new NotFoundException("Clip not found");
    if (doc.ownerId.toString() !== ownerId) {
      throw new ForbiddenException("You can only modify your own clips");
    }
    return doc;
  }

  private toItem(d: {
    _id: Types.ObjectId;
    mediaId: Types.ObjectId | MediaAsset;
    title?: string;
    lastUsedAt?: Date | null;
    usageCount?: number;
  }): ClipItem {
    const asset = d.mediaId as MediaAsset & { _id: Types.ObjectId };
    return {
      id: d._id.toString(),
      mediaId: asset._id.toString(),
      title: d.title ?? "",
      relativePath: this.mediaService.variantPath(asset, "original"),
      lastUsedAt: d.lastUsedAt ? d.lastUsedAt.toISOString() : null,
      usageCount: d.usageCount ?? 0,
    };
  }
}
