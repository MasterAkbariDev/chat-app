import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  User,
  type QuickReactionItem,
  type RecentEmoji,
} from "./schema/user.schema";
import { PacksService } from "src/packs/packs.service";
import { PackType } from "src/enum/base.enum";
import { Block } from "./schema/block.schema";
import { Contact } from "src/contacts/schema/contact.schema";
import { CreateUserDto } from "./dto/create-user.dto";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { hashPassword } from "src/utils/hash.util";
import { UpdateUserDto } from "./dto/update-user.dto";
import { PresenceService } from "src/presence/presence.service";
import { TokenCacheService } from "src/auth/token-cache.service";
import {
  MeDto,
  ProfileViewDto,
  toMeDto,
  toProfileViewDto,
  toPublicUserDto,
} from "src/common/dto/user-view.dto";
import {
  PrivacyService,
  type PresenceView,
  type PrivacyRulesView,
} from "src/privacy/privacy.service";
import { ProfilePhotoDto } from "src/common/dto/user-view.dto";
import type { ProfilePhoto } from "./schema/user.schema";

const MAX_PROFILE_PHOTOS = 100;
/** Recent emoji kept per user (plain and animated together), newest first. */
export const RECENT_EMOJI_MAX = 30;

/** Profile photos must be media this server stored (no hot-linking/tracking pixels). */
function assertOwnMediaUrl(url: string) {
  let pathname: string;
  try {
    pathname = new URL(url, "http://local").pathname;
  } catch {
    throw new BadRequestException("Invalid photo URL");
  }
  if (
    !/^\/uploads\/media\/[\w\-./]+$/.test(pathname) ||
    pathname.includes("..")
  ) {
    throw new BadRequestException(
      "Upload the photo first, then use the URL the upload returned",
    );
  }
}

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) public userModel: Model<User>,
    @InjectModel(Block.name) private blockModel: Model<Block>,
    @InjectModel(Contact.name) private contactModel: Model<Contact>,
    private presenceService: PresenceService,
    private tokenCacheService: TokenCacheService,
    private packsService: PacksService,
    private privacy: PrivacyService,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    const existingByEmail = await this.userModel.findOne({
      email: createUserDto.email,
      isDeleted: false,
    });
    if (existingByEmail) {
      throw new BadRequestException("User already exists with this email");
    }
    const existingByUsername = await this.userModel.findOne({
      username: (createUserDto.username ?? "").toLowerCase().trim(),
      isDeleted: false,
    });
    if (existingByUsername) {
      throw new BadRequestException("Username is already taken");
    }
    const hashed = await hashPassword(createUserDto.password);
    const user = new this.userModel({
      ...createUserDto,
      password: hashed,
    });
    return user.save();
  }

  async update(id: string, data: UpdateUserDto): Promise<MeDto> {
    // DTO field is `avatarUrl` (the wire name every client actually sends); the schema's
    // internal field stays `image`. Map here so the boundary owns the rename, not the schema.
    // `avatarUrl` is the older single-photo API: `[url]` adds that photo as the main one,
    // `[]` removes the current main photo. Both go through the photo list below.
    const { avatarUrl, ...rest } = data;
    const updateData: Record<string, unknown> = { ...rest };
    if (avatarUrl !== undefined) {
      if (avatarUrl[0])
        await this.addPhoto(id, { url: avatarUrl[0], kind: "image" });
      else {
        const current = await this.listPhotos(id);
        if (current[0]) await this.deletePhoto(id, current[0].id);
      }
    }

    if (data.username !== undefined) {
      const existing = await this.userModel.findOne({
        username: data.username.toLowerCase().trim(),
        isDeleted: false,
        _id: { $ne: id },
      });
      if (existing) {
        throw new BadRequestException("Username is already taken");
      }
    }
    const user = await this.userModel
      .findOneAndUpdate(
        { _id: id, isDeleted: false },
        { $set: updateData },
        { new: true },
      )
      .select("-password -__v -isDeleted -tokenVersion")
      .exec();
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return toMeDto(user);
  }

  // ---- Profile photos ------------------------------------------------------

  /** Someone else's photos, as `viewerId` may see them (empty when their privacy hides them). */
  async listPhotosFor(
    userId: string,
    viewerId: string,
  ): Promise<ProfilePhotoDto[]> {
    if (userId !== viewerId) {
      const [visible, blocked] = await Promise.all([
        this.privacy.allows(userId, viewerId, "profilePhotos"),
        this.isBlocked(userId, viewerId),
      ]);
      if (!visible || blocked) {
        if (!Types.ObjectId.isValid(userId))
          throw new NotFoundException("User not found");
        const exists = await this.userModel.exists({
          _id: userId,
          isDeleted: false,
        });
        if (!exists) throw new NotFoundException("User not found");
        return [];
      }
    }
    return this.listPhotos(userId);
  }

  /** The owner's own photo list (no privacy filter). Main first. */
  async listPhotos(userId: string): Promise<ProfilePhotoDto[]> {
    if (!Types.ObjectId.isValid(userId))
      throw new NotFoundException("User not found");
    const user = await this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select("photos image");
    if (!user) throw new NotFoundException("User not found");
    // Accounts from before the photo list: adopt their single photo.
    if (!user.photos?.length && user.image?.[0]) {
      user.photos = [
        {
          url: user.image[0],
          kind: "image",
          posterUrl: null,
          createdAt: new Date(),
        } as ProfilePhoto,
      ];
      await user.save();
    }
    return (user.photos ?? []).map((p, i) => ({
      id: String(p._id),
      url: p.url,
      kind: p.kind ?? "image",
      posterUrl: p.posterUrl ?? null,
      createdAt: p.createdAt,
      isMain: i === 0,
    }));
  }

  async addPhoto(
    userId: string,
    input: {
      url: string;
      kind?: "image" | "video";
      posterUrl?: string | null;
      makeMain?: boolean;
    },
  ): Promise<ProfilePhotoDto[]> {
    assertOwnMediaUrl(input.url);
    if (input.posterUrl) assertOwnMediaUrl(input.posterUrl);
    const kind = input.kind ?? "image";
    if (kind === "video" && !input.posterUrl)
      throw new BadRequestException("A video photo needs its posterUrl");
    await this.listPhotos(userId); // adopts a legacy photo first
    const user = await this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select("photos image avatarVideo");
    if (!user) throw new NotFoundException("User not found");
    if (user.photos.length >= MAX_PROFILE_PHOTOS) {
      throw new BadRequestException(
        `You can have up to ${MAX_PROFILE_PHOTOS} profile photos. Delete one first.`,
      );
    }
    const photo = {
      url: input.url,
      kind,
      posterUrl: input.posterUrl ?? null,
      createdAt: new Date(),
    } as ProfilePhoto;
    if (input.makeMain === false && user.photos.length)
      user.photos.splice(1, 0, photo);
    else user.photos.unshift(photo);
    this.syncMainPhoto(user);
    await user.save();
    return this.listPhotos(userId);
  }

  async setMainPhoto(
    userId: string,
    photoId: string,
  ): Promise<ProfilePhotoDto[]> {
    const user = await this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select("photos image avatarVideo");
    if (!user) throw new NotFoundException("User not found");
    const index = user.photos.findIndex(p => String(p._id) === photoId);
    if (index < 0) throw new NotFoundException("Photo not found");
    const [photo] = user.photos.splice(index, 1);
    user.photos.unshift(photo);
    this.syncMainPhoto(user);
    await user.save();
    return this.listPhotos(userId);
  }

  async deletePhoto(
    userId: string,
    photoId: string,
  ): Promise<ProfilePhotoDto[]> {
    const user = await this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select("photos image avatarVideo");
    if (!user) throw new NotFoundException("User not found");
    const index = user.photos.findIndex(p => String(p._id) === photoId);
    if (index < 0) throw new NotFoundException("Photo not found");
    user.photos.splice(index, 1);
    this.syncMainPhoto(user);
    await user.save();
    return this.listPhotos(userId);
  }

  /** `image`/`avatarVideo` mirror the main photo so every existing reader keeps working. */
  private syncMainPhoto(user: {
    photos: ProfilePhoto[];
    image: string[];
    avatarVideo: string | null;
  }) {
    const main = user.photos[0];
    user.image = main
      ? [main.kind === "video" ? (main.posterUrl ?? main.url) : main.url]
      : [];
    user.avatarVideo = main?.kind === "video" ? main.url : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const user = await this.userModel
      .findOne(
        { email, isDeleted: false },
        { __v: 0, password: 0, isDeleted: 0 },
      )
      .exec();
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return user;
  }

  private static readonly PROFILE_FIELDS = {
    username: 1,
    firstName: 1,
    lastName: 1,
    image: 1,
    avatarVideo: 1,
    bio: 1,
    phoneNumber: 1,
    email: 1,
  } as const;

  /**
   * Fetches a user's profile as `viewerId` may see it: photos, bio, phone number and email
   * each filtered by that user's privacy settings, plus what the viewer may do (`canCall`,
   * `canAddToGroups`). The viewer's own profile comes back complete.
   */
  async findOne(id: string, viewerId?: string): Promise<ProfileViewDto> {
    // Guard against invalid ObjectId values (e.g. "1", "2") to avoid CastError -> 500.
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException("User not found");
    }
    const user = await this.userModel
      .findOne({ _id: id, isDeleted: false }, UserService.PROFILE_FIELDS)
      .lean()
      .exec();
    if (!user) throw new NotFoundException("User not found");
    return this.profileFor(user, viewerId);
  }

  async findByUsername(
    username: string,
    viewerId?: string,
  ): Promise<ProfileViewDto> {
    const user = await this.userModel
      .findOne({ username, isDeleted: false }, UserService.PROFILE_FIELDS)
      .lean()
      .exec();
    if (!user) throw new NotFoundException("User not found");
    return this.profileFor(user, viewerId);
  }

  private async profileFor(
    user: Parameters<typeof toProfileViewDto>[1] & { _id: Types.ObjectId },
    viewerId?: string,
  ): Promise<ProfileViewDto> {
    const id = String(user._id);
    if (viewerId && viewerId === id) {
      return toProfileViewDto(
        toPublicUserDto(user),
        user,
        { phoneNumber: true, email: true },
        { canCall: false, canAddToGroups: false },
      );
    }
    if (!viewerId) {
      return toProfileViewDto(
        toPublicUserDto(user),
        user,
        { phoneNumber: false, email: false },
        { canCall: false, canAddToGroups: false },
      );
    }
    const [view, blocked] = await Promise.all([
      this.privacy.forViewer(viewerId, [id]),
      this.isBlockedEitherWay(id, viewerId),
    ]);
    return toProfileViewDto(
      view.publicUser(user),
      user,
      {
        phoneNumber: view.can(id, "phoneNumber"),
        email: view.can(id, "email"),
      },
      {
        canCall: !blocked && view.can(id, "calls"),
        canAddToGroups: !blocked && view.can(id, "groupInvites"),
      },
    );
  }

  private async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(a) || !Types.ObjectId.isValid(b)) return false;
    const doc = await this.blockModel
      .exists({
        $or: [
          {
            blockerId: new Types.ObjectId(a),
            blockedId: new Types.ObjectId(b),
          },
          {
            blockerId: new Types.ObjectId(b),
            blockedId: new Types.ObjectId(a),
          },
        ],
      })
      .exec();
    return !!doc;
  }

  async findAll(): Promise<User[]> {
    return this.userModel.find({ isDeleted: false }).exec();
  }

  // People search lives in PeopleDiscoveryService (privacy-aware) — never query users by
  // name/username/phone/email from here.

  /** The ids among `userIds` whose "Groups & channels" privacy doesn't let `adderId` add them. */
  async restrictedForGroupInvites(
    adderId: string,
    userIds: string[],
  ): Promise<string[]> {
    const view = await this.privacy.forViewer(adderId, userIds);
    return [...new Set(userIds)].filter(
      id => id !== adderId && !view.can(id, "groupInvites"),
    );
  }

  getPrivacy(userId: string): Promise<PrivacyRulesView> {
    return this.privacy.getSettings(userId);
  }

  updatePrivacy(
    userId: string,
    patch: Record<string, unknown>,
  ): Promise<PrivacyRulesView> {
    return this.privacy.updateSettings(userId, patch);
  }

  /** Last seen / online as `viewerId` may see it (an approximate bucket when hidden). */
  async getUserStatus(userId: string, viewerId: string): Promise<PresenceView> {
    if (!Types.ObjectId.isValid(userId))
      throw new NotFoundException("User not found");
    const user = await this.userModel
      .findById(userId)
      .select("lastSeen")
      .lean()
      .exec();
    if (!user) throw new NotFoundException("User not found");
    const [view, isOnline] = await Promise.all([
      this.privacy.forViewer(viewerId, [userId]),
      this.presenceService.isOnline(userId),
    ]);
    return view.presence(userId, user.lastSeen, isOnline);
  }

  async remove(id: string = "", user_id: string = ""): Promise<boolean> {
    if (!new Types.ObjectId(id).equals(new Types.ObjectId(user_id))) {
      throw new BadRequestException("You are not allowed to delete this user");
    }
    const user = await this.userModel
      .findOneAndUpdate(
        { _id: id },
        { $set: { isDeleted: true }, $inc: { tokenVersion: 1 } },
        { new: true },
      )
      .exec();
    if (!user) {
      throw new BadRequestException("User not found");
    }
    await this.tokenCacheService.invalidate(id);
    return true;
  }

  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new BadRequestException("Cannot block yourself");
    }
    const existing = await this.blockModel
      .findOne({
        blockerId: new Types.ObjectId(blockerId),
        blockedId: new Types.ObjectId(blockedId),
      })
      .exec();
    if (existing) return;
    await this.blockModel.create({
      blockerId: new Types.ObjectId(blockerId),
      blockedId: new Types.ObjectId(blockedId),
    });
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.blockModel
      .deleteOne({
        blockerId: new Types.ObjectId(blockerId),
        blockedId: new Types.ObjectId(blockedId),
      })
      .exec();
  }

  async getBlockedUserIds(blockerId: string): Promise<string[]> {
    if (!Types.ObjectId.isValid(blockerId)) {
      return [];
    }
    const list = await this.blockModel
      .find({ blockerId: new Types.ObjectId(blockerId) })
      .select("blockedId")
      .lean()
      .exec();
    return list.map(b => String(b.blockedId));
  }

  async isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    if (
      !Types.ObjectId.isValid(blockerId) ||
      !Types.ObjectId.isValid(blockedId)
    ) {
      // If either id is not a valid ObjectId, treat as "not blocked" instead of throwing.
      return false;
    }
    const doc = await this.blockModel
      .findOne({
        blockerId: new Types.ObjectId(blockerId),
        blockedId: new Types.ObjectId(blockedId),
      })
      .exec();
    return !!doc;
  }

  /**
   * Sets the double-tap/quick reaction: either a plain emoji, or (`packItemId`) an animated
   * emoji from a pack the user owns or has added. The animated one is stored denormalized in
   * `quickReactionItem`, with its emoji keyword kept in `quickReaction` as the fallback older
   * clients use.
   */
  async updateQuickReaction(
    userId: string,
    emoji?: string,
    packItemId?: string,
  ) {
    if (!userId) throw new BadRequestException("User id cannot be empty");
    const trimmedEmoji = (emoji ?? "").trim();
    const trimmedItem = (packItemId ?? "").trim();
    if (!trimmedEmoji && !trimmedItem) {
      throw new BadRequestException("emoji or packItemId is required");
    }
    if (trimmedEmoji && trimmedItem) {
      throw new BadRequestException(
        "Provide either emoji or packItemId, not both",
      );
    }
    if (trimmedEmoji && [...trimmedEmoji].length > 16) {
      throw new BadRequestException("Quick reaction must be a single emoji");
    }
    const user = await this.findOne(userId);

    if (!user) throw new BadRequestException("Please provide a valid user id");

    if (trimmedItem) {
      const item = await this.packsService.describeUsableItem(
        trimmedItem,
        userId,
      );
      if (item.packType !== PackType.EMOJI) {
        throw new BadRequestException(
          "Only animated emoji can be a quick reaction",
        );
      }
      const fallback =
        item.keywords.find(
          k => /\p{Extended_Pictographic}/u.test(k) && [...k].length <= 8,
        ) ?? "👍";
      const quickReactionItem: QuickReactionItem = {
        packItemId: trimmedItem,
        packId: item.packId,
        relativePath: item.relativePath,
        thumbPath: item.thumbPath,
        stillPath: item.stillPath,
      };
      await this.userModel
        .updateOne(
          { _id: userId },
          { $set: { quickReaction: fallback, quickReactionItem } },
        )
        .exec();
      return true;
    }

    await this.userModel
      .updateOne(
        { _id: userId },
        { $set: { quickReaction: trimmedEmoji, quickReactionItem: null } },
      )
      .exec();

    return true;
  }

  /** The user's recent emoji, newest first. */
  async getRecentEmoji(userId: string): Promise<RecentEmoji[]> {
    const user = await this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select("recentEmoji")
      .lean()
      .exec();
    return user?.recentEmoji ?? [];
  }

  /**
   * Records a pick at the front of the user's recent emoji. A repeat moves up instead of
   * duplicating, and the list never holds more than RECENT_EMOJI_MAX. An animated emoji must be
   * one the user can use (the same check as the quick reaction).
   */
  async addRecentEmoji(
    userId: string,
    input: { emoji?: string; packItemId?: string },
  ): Promise<RecentEmoji[]> {
    const emoji = (input.emoji ?? "").trim();
    const packItemId = (input.packItemId ?? "").trim();
    if (!emoji && !packItemId) {
      throw new BadRequestException("emoji or packItemId is required");
    }
    if (emoji && packItemId) {
      throw new BadRequestException(
        "Provide either emoji or packItemId, not both",
      );
    }

    let entry: RecentEmoji;
    if (packItemId) {
      const item = await this.packsService.describeUsableItem(
        packItemId,
        userId,
      );
      if (item.packType !== PackType.EMOJI) {
        throw new BadRequestException(
          "Only animated emoji are kept as recent here",
        );
      }
      const fallback =
        item.keywords.find(
          k => /\p{Extended_Pictographic}/u.test(k) && [...k].length <= 8,
        ) ?? "✨";
      entry = {
        key: `a:${packItemId}`,
        emoji: null,
        fallback,
        item: {
          packItemId,
          packId: item.packId,
          relativePath: item.relativePath,
          thumbPath: item.thumbPath,
          stillPath: item.stillPath,
        },
      };
    } else {
      if ([...emoji].length > 16) {
        throw new BadRequestException("Recent emoji must be a single emoji");
      }
      entry = { key: `u:${emoji}`, emoji, fallback: emoji, item: null };
    }

    await this.userModel
      .updateOne(
        { _id: userId },
        { $pull: { recentEmoji: { key: entry.key } } },
      )
      .exec();
    await this.userModel
      .updateOne(
        { _id: userId },
        {
          $push: {
            recentEmoji: {
              $each: [entry],
              $position: 0,
              $slice: RECENT_EMOJI_MAX,
            },
          },
        },
      )
      .exec();
    return this.getRecentEmoji(userId);
  }

  async setNotificationLevel(
    userId: string,
    level: "all" | "mentions" | "none",
  ): Promise<{ success: boolean }> {
    await this.userModel
      .updateOne({ _id: userId }, { $set: { notificationLevel: level } })
      .exec();
    return { success: true };
  }
}
