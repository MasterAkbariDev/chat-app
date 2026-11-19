import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Request } from "express";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { extname, join } from "path";
import { ChatType, MessageType } from "src/enum/base.enum";
import { Chat } from "src/chat/schema/chat.schema";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Message } from "src/message/schema/message.schema";
import { User } from "src/user/schema/user.schema";
import {
  Wallpaper,
  WallpaperFitMode,
  WallpaperType,
} from "./schema/wallpaper.schema";
import {
  AcceptWallpaperDto,
  ApplyWallpaperDto,
  UpdateWallpaperSettingsDto,
} from "./dto/wallpaper-settings.dto";
import {
  WallpaperMediaService,
  WALLPAPER_MAX_VIDEO_SEC,
  WALLPAPER_MAX_IMAGE_BYTES,
  WALLPAPER_MAX_VIDEO_BYTES,
} from "./wallpaper-media.service";
import { MediaService } from "src/media/media.service";
import { ChatGateway } from "src/gateway/chat.gateway";
import { Inject, forwardRef } from "@nestjs/common";
import { buildMediaUrl } from "src/media/media-url.util";

export interface WallpaperResponse {
  id: string;
  type: WallpaperType;
  mediaUrl: string;
  thumbnailUrl: string | null;
  blur: number;
  dim: number;
  brightness: number;
  fitMode: WallpaperFitMode;
  parallax: boolean;
  duration: number | null;
  /** The upload backing this wallpaper; send it back on apply when re-picking it. */
  mediaId: string | null;
  videoStartSec: number;
  channelId: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface EffectiveWallpaperResponse extends WallpaperResponse {
  source: "chat" | "global" | "default";
}

/** Simple per-user upload rate limit: max 10 uploads per 10 minutes */
const uploadTimestamps = new Map<string, number[]>();

@Injectable()
export class WallpaperService {
  constructor(
    @InjectModel(Wallpaper.name) private wallpaperModel: Model<Wallpaper>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(ChatMembers.name)
    private chatMembersModel: Model<ChatMembers>,
    @InjectModel(Chat.name) private chatModel: Model<Chat>,
    @InjectModel(Message.name) private messageModel: Model<Message>,
    private wallpaperMedia: WallpaperMediaService,
    private mediaService: MediaService,
    @Inject(forwardRef(() => ChatGateway))
    private chatGateway: ChatGateway,
  ) {}

  private notifyWallpaperUpdated(
    userId: string,
    channelId: string | null,
    wallpaper: WallpaperResponse | null,
  ): void {
    this.chatGateway.emitToUser(userId, "wallpaper_updated", {
      channelId,
      wallpaper,
    });
  }

  private checkUploadRateLimit(userId: string): void {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const max = 10;
    const prev = uploadTimestamps.get(userId) ?? [];
    const recent = prev.filter(t => now - t < windowMs);
    if (recent.length >= max) {
      throw new BadRequestException(
        "Too many wallpaper uploads. Try again in a few minutes.",
      );
    }
    recent.push(now);
    uploadTimestamps.set(userId, recent);
  }

  async uploadImage(
    userId: string,
    file: Express.Multer.File,
    req: Request,
  ): Promise<{ url: string; mediaId: string }> {
    this.checkUploadRateLimit(userId);
    if (!file) throw new BadRequestException("No image file provided");
    if (file.size > WALLPAPER_MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        `Image must be ${WALLPAPER_MAX_IMAGE_BYTES / (1024 * 1024)} MB or smaller`,
      );
    }
    const asset = await this.mediaService.ingestImage(file.buffer, userId);
    return {
      url: buildMediaUrl(
        req,
        `/uploads/media/${this.mediaService.variantPath(asset, "web")}`,
      ),
      mediaId: asset._id.toString(),
    };
  }

  async uploadVideo(
    userId: string,
    file: Express.Multer.File,
    req: Request,
  ): Promise<{
    url: string;
    duration: number;
    thumbnailUrl: string;
    mediaId: string;
  }> {
    this.checkUploadRateLimit(userId);
    if (!file) throw new BadRequestException("No video file provided");
    if (file.size > WALLPAPER_MAX_VIDEO_BYTES) {
      throw new BadRequestException(
        `Video must be ${WALLPAPER_MAX_VIDEO_BYTES / (1024 * 1024)} MB or smaller`,
      );
    }

    const tempDir = mkdtempSync(join(tmpdir(), "wallpaper-video-"));
    try {
      const inputPath = join(
        tempDir,
        `input${extname(file.originalname) || ".mp4"}`,
      );
      writeFileSync(inputPath, file.buffer);

      const duration = await this.wallpaperMedia.assertVideoMaxDuration(
        inputPath,
        WALLPAPER_MAX_VIDEO_SEC,
      );
      const trimmedBuffer = readFileSync(inputPath);
      // Silent, 720p-class, ≤24 fps loop: it plays behind every chat, so it must be cheap.
      const asset = await this.mediaService.ingestLoopVideo(
        trimmedBuffer,
        userId,
        {
          maxDimension: 1280,
          maxSec: WALLPAPER_MAX_VIDEO_SEC,
          fps: 24,
        },
      );

      return {
        url: buildMediaUrl(
          req,
          `/uploads/media/${this.mediaService.variantPath(asset, "web")}`,
        ),
        duration,
        thumbnailUrl: buildMediaUrl(
          req,
          `/uploads/media/${this.mediaService.variantPath(asset, "poster")}`,
        ),
        mediaId: asset._id.toString(),
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private toResponse(doc: Wallpaper): WallpaperResponse {
    return {
      id: doc._id.toString(),
      type: doc.type,
      mediaUrl: doc.mediaUrl,
      thumbnailUrl: doc.thumbnailUrl,
      blur: doc.blur,
      dim: doc.dim,
      brightness: doc.brightness,
      fitMode: doc.fitMode,
      parallax: doc.parallax,
      duration: doc.duration,
      mediaId: doc.mediaId ? doc.mediaId.toString() : null,
      videoStartSec: doc.videoStartSec ?? 0,
      channelId: doc.channelId,
      ownerId: doc.ownerId.toString(),
      createdAt: doc.createdAt?.toISOString?.() ?? new Date().toISOString(),
      updatedAt: doc.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    };
  }

  /**
   * Upserts the one `Wallpaper` doc for this (ownerId, channelId) scope instead of creating a
   * new one on every apply (B9 — "stop doc-per-apply"). If the scope already had a different
   * `mediaId`, that MediaAsset's reference is released first. Note: because this mutates the
   * *same* document in place, anyone who previously accepted this scope's wallpaper via
   * `acceptShared` (which points their own `chatWallpaperId` at this same `_id`) will see the
   * new content too, not the content as of when they accepted — a deliberate consequence of no
   * longer leaving an unbounded trail of orphaned docs behind every apply.
   */
  private async upsertWallpaper(
    userId: string,
    dto: ApplyWallpaperDto,
    channelId: string | null,
  ): Promise<Wallpaper> {
    if (dto.type === "video" && dto.duration != null) {
      if (dto.duration > WALLPAPER_MAX_VIDEO_SEC) {
        throw new BadRequestException(
          `Video duration cannot exceed ${WALLPAPER_MAX_VIDEO_SEC} seconds`,
        );
      }
    }
    const ownerId = new Types.ObjectId(userId);
    const newMediaId = dto.mediaId ? new Types.ObjectId(dto.mediaId) : null;

    const prior = await this.wallpaperModel
      .findOne({ ownerId, channelId })
      .select("mediaId")
      .lean()
      .exec();
    const changed =
      !prior?.mediaId || !newMediaId || !prior.mediaId.equals(newMediaId);
    if (prior?.mediaId && changed) {
      await this.mediaService.release(prior.mediaId.toString());
    }
    // A fresh upload's own reference is handed to its first apply. Re-picking an earlier upload
    // (whose reference was released when it was replaced), or using one file in a second scope,
    // needs a reference of its own, or the file would read as unused while it's on screen.
    if (newMediaId && changed) {
      const [asset, otherUse] = await Promise.all([
        this.mediaService.findById(newMediaId.toString()),
        this.wallpaperModel
          .exists({ mediaId: newMediaId, $nor: [{ ownerId, channelId }] })
          .exec(),
      ]);
      if (!asset) throw new BadRequestException("Unknown mediaId");
      if (asset.refCount <= 0 || otherUse)
        await this.mediaService.retain(newMediaId.toString());
    }

    return this.wallpaperModel
      .findOneAndUpdate(
        { ownerId, channelId },
        {
          $set: {
            type: dto.type,
            mediaUrl: dto.mediaUrl,
            thumbnailUrl:
              dto.thumbnailUrl ?? (dto.type === "image" ? dto.mediaUrl : null),
            blur: dto.blur ?? 0,
            dim: dto.dim ?? 0,
            brightness: dto.brightness ?? 100,
            fitMode: dto.fitMode ?? WallpaperFitMode.COVER,
            parallax: dto.parallax ?? false,
            duration:
              dto.type === "video"
                ? (dto.duration ?? WALLPAPER_MAX_VIDEO_SEC)
                : null,
            videoStartSec: dto.videoStartSec ?? 0,
            originalFilename: dto.originalFilename ?? null,
            mediaId: newMediaId,
          },
        },
        { upsert: true, new: true },
      )
      .exec();
  }

  async applyGlobal(
    userId: string,
    dto: ApplyWallpaperDto,
  ): Promise<WallpaperResponse> {
    const wallpaper = await this.upsertWallpaper(userId, dto, null);
    await this.userModel
      .updateOne(
        { _id: new Types.ObjectId(userId) },
        { $set: { globalWallpaperId: wallpaper._id } },
      )
      .exec();
    const res = this.toResponse(wallpaper);
    this.notifyWallpaperUpdated(userId, null, res);
    return res;
  }

  async resetGlobal(userId: string): Promise<void> {
    await this.userModel
      .updateOne(
        { _id: new Types.ObjectId(userId) },
        { $set: { globalWallpaperId: null } },
      )
      .exec();
    this.notifyWallpaperUpdated(userId, null, null);
  }

  async getGlobal(userId: string): Promise<WallpaperResponse | null> {
    const user = await this.userModel
      .findById(userId)
      .select("globalWallpaperId")
      .lean()
      .exec();
    if (!user?.globalWallpaperId) return null;
    const wp = await this.wallpaperModel
      .findById(user.globalWallpaperId)
      .exec();
    if (!wp) return null;
    return this.toResponse(wp);
  }

  private async assertChatMember(
    userId: string,
    channelId: string,
  ): Promise<Chat> {
    const chat = await this.chatModel.findById(channelId).lean().exec();
    if (!chat || chat.isDeleted) {
      throw new NotFoundException("Chat not found");
    }
    if (chat.type !== ChatType.PRIVATE && chat.type !== ChatType.GROUP) {
      throw new BadRequestException(
        "Per-chat wallpapers are only available in private and group chats",
      );
    }
    const member = await this.chatMembersModel
      .findOne({ channelId, userId, isJoined: true })
      .lean()
      .exec();
    if (!member) throw new ForbiddenException("Not a member of this chat");
    return chat;
  }

  async applyChat(
    userId: string,
    channelId: string,
    dto: ApplyWallpaperDto,
  ): Promise<{ wallpaper: WallpaperResponse; messageId: string }> {
    await this.assertChatMember(userId, channelId);
    const owner = await this.userModel
      .findById(userId)
      .select("firstName lastName username")
      .lean()
      .exec();
    const senderDisplayName =
      [owner?.firstName, owner?.lastName].filter(Boolean).join(" ").trim() ||
      owner?.username ||
      "Someone";
    const wallpaper = await this.upsertWallpaper(userId, dto, channelId);

    await this.chatMembersModel
      .updateOne(
        { channelId, userId },
        {
          $set: {
            chatWallpaperId: wallpaper._id,
            wallpaperBlur: dto.blur ?? 0,
            wallpaperDim: dto.dim ?? 0,
            wallpaperBrightness: dto.brightness ?? 100,
          },
        },
      )
      .exec();

    const message = await this.messageModel.create({
      channelId,
      senderId: new Types.ObjectId(userId),
      content: "wallpaper_changed",
      type: MessageType.SYSTEM,
      metadata: {
        wallpaperId: wallpaper._id.toString(),
        senderName: senderDisplayName,
        action: "wallpaper_share",
        mediaUrl: wallpaper.mediaUrl,
        thumbnailUrl: wallpaper.thumbnailUrl ?? wallpaper.mediaUrl,
        wallpaperType: wallpaper.type,
      },
    });

    this.chatGateway.broadcastNewMessage(
      channelId,
      JSON.parse(JSON.stringify(message)) as Record<string, unknown>,
    );

    const res = this.toResponse(wallpaper);
    this.notifyWallpaperUpdated(userId, channelId, res);
    return {
      wallpaper: res,
      messageId: message._id.toString(),
    };
  }

  async resetChat(userId: string, channelId: string): Promise<void> {
    await this.assertChatMember(userId, channelId);
    await this.chatMembersModel
      .updateOne(
        { channelId, userId },
        {
          $set: {
            chatWallpaperId: null,
            wallpaperBlur: null,
            wallpaperDim: null,
            wallpaperBrightness: null,
          },
        },
      )
      .exec();
    this.notifyWallpaperUpdated(userId, channelId, null);
  }

  /** Membership-guarded (B9 acceptance: "wallpaper reads are membership-guarded"). */
  async getChat(
    userId: string,
    channelId: string,
  ): Promise<WallpaperResponse | null> {
    await this.assertChatMember(userId, channelId);
    const member = await this.chatMembersModel
      .findOne({ channelId, userId })
      .lean()
      .exec();
    if (!member?.chatWallpaperId) return null;
    const wp = await this.wallpaperModel
      .findById(member.chatWallpaperId)
      .exec();
    if (!wp) return null;
    const res = this.toResponse(wp);
    if (member.wallpaperBlur != null) res.blur = member.wallpaperBlur;
    if (member.wallpaperDim != null) res.dim = member.wallpaperDim;
    if (member.wallpaperBrightness != null)
      res.brightness = member.wallpaperBrightness;
    return res;
  }

  async getEffective(
    userId: string,
    channelId: string,
  ): Promise<EffectiveWallpaperResponse | null> {
    const chatWp = await this.getChat(userId, channelId);
    if (chatWp) return { ...chatWp, source: "chat" };
    const globalWp = await this.getGlobal(userId);
    if (globalWp) return { ...globalWp, source: "global" };
    return null;
  }

  /** Membership-guarded: the wallpaper's own owner, or (for a chat-scoped one) any member of
   *  that chat. A global wallpaper is private to its owner — not fetchable by id by anyone else. */
  async getById(
    wallpaperId: string,
    userId: string,
  ): Promise<WallpaperResponse> {
    const wp = await this.wallpaperModel.findById(wallpaperId).exec();
    if (!wp) throw new NotFoundException("Wallpaper not found");
    if (wp.ownerId.toString() !== userId) {
      if (!wp.channelId) {
        throw new ForbiddenException("Cannot view this wallpaper");
      }
      await this.assertChatMember(userId, wp.channelId);
    }
    return this.toResponse(wp);
  }

  async acceptShared(
    userId: string,
    wallpaperId: string,
    channelId: string,
    dto: AcceptWallpaperDto,
  ): Promise<WallpaperResponse> {
    await this.assertChatMember(userId, channelId);
    const wp = await this.wallpaperModel.findById(wallpaperId).exec();
    if (!wp) throw new NotFoundException("Wallpaper not found");

    const blur = dto.blur ?? wp.blur;
    const dim = dto.dim ?? wp.dim;
    const brightness = dto.brightness ?? wp.brightness;

    await this.chatMembersModel
      .updateOne(
        { channelId, userId },
        {
          $set: {
            chatWallpaperId: wp._id,
            wallpaperBlur: blur,
            wallpaperDim: dim,
            wallpaperBrightness: brightness,
          },
        },
      )
      .exec();

    const res = this.toResponse(wp);
    res.blur = blur;
    res.dim = dim;
    res.brightness = brightness;
    this.notifyWallpaperUpdated(userId, channelId, res);
    return res;
  }

  async updateSettings(
    userId: string,
    wallpaperId: string,
    dto: UpdateWallpaperSettingsDto,
    scope: "global" | "chat",
    channelId?: string,
  ): Promise<WallpaperResponse> {
    const wp = await this.wallpaperModel.findById(wallpaperId).exec();
    if (!wp || wp.ownerId.toString() !== userId) {
      throw new ForbiddenException("Cannot update this wallpaper");
    }
    const updates: Partial<Wallpaper> = {};
    if (dto.blur != null) updates.blur = dto.blur;
    if (dto.dim != null) updates.dim = dto.dim;
    if (dto.brightness != null) updates.brightness = dto.brightness;
    if (dto.fitMode != null) updates.fitMode = dto.fitMode;
    if (dto.parallax != null) updates.parallax = dto.parallax;
    Object.assign(wp, updates);
    await wp.save();

    if (scope === "chat" && channelId) {
      const memberUpdates: Record<string, number> = {};
      if (dto.blur != null) memberUpdates.wallpaperBlur = dto.blur;
      if (dto.dim != null) memberUpdates.wallpaperDim = dto.dim;
      if (dto.brightness != null)
        memberUpdates.wallpaperBrightness = dto.brightness;
      if (Object.keys(memberUpdates).length) {
        await this.chatMembersModel
          .updateOne({ channelId, userId }, { $set: memberUpdates })
          .exec();
      }
    }

    return this.toResponse(wp);
  }
}
