import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
  WallpaperFitMode,
  WallpaperType,
} from "src/wallpaper/schema/wallpaper.schema";
import {
  MediaAsset,
  MediaAssetSchema,
} from "src/media/schema/media-asset.schema";
import { MediaService } from "src/media/media.service";
import { DiskMediaStorageService } from "src/media/storage/disk-media-storage.service";
import { TokenCacheService } from "src/auth/token-cache.service";
import { AccountDeletionService } from "./account-deletion.service";
import { hashPassword } from "src/utils/hash.util";
import { PackType } from "src/enum/base.enum";

const ONE_PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

describe("AccountDeletionService (B4: re-auth + cleanup job)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let BlockModel: Model<Block>;
  let ChatMembersModel: Model<ChatMembers>;
  let SessionModel: Model<Session>;
  let ClipModel: Model<Clip>;
  let PackModel: Model<Pack>;
  let PackItemModel: Model<PackItem>;
  let PackSubscriptionModel: Model<PackSubscription>;
  let WallpaperModel: Model<Wallpaper>;
  let MediaAssetModel: Model<MediaAsset>;
  let mediaService: MediaService;
  let service: AccountDeletionService;
  let tempRoot: string;

  const invalidateMock = jest.fn();
  const fakeTokenCache = {
    invalidate: invalidateMock,
  } as unknown as TokenCacheService;

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "account-deletion-test-"));
    process.env.MEDIA_STORAGE_ROOT = tempRoot;

    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    BlockModel = connection.model(Block.name, BlockSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    SessionModel = connection.model(Session.name, SessionSchema);
    ClipModel = connection.model(Clip.name, ClipSchema);
    PackModel = connection.model(Pack.name, PackSchema);
    PackItemModel = connection.model(PackItem.name, PackItemSchema);
    PackSubscriptionModel = connection.model(
      PackSubscription.name,
      PackSubscriptionSchema,
    );
    WallpaperModel = connection.model(Wallpaper.name, WallpaperSchema);
    MediaAssetModel = connection.model(MediaAsset.name, MediaAssetSchema);

    mediaService = new MediaService(
      MediaAssetModel,
      new DiskMediaStorageService(),
    );
    service = new AccountDeletionService(
      UserModel,
      BlockModel,
      ChatMembersModel,
      SessionModel,
      ClipModel,
      PackModel,
      PackItemModel,
      PackSubscriptionModel,
      WallpaperModel,
      mediaService,
      fakeTokenCache,
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.MEDIA_STORAGE_ROOT;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("rejects the wrong password and changes nothing", async () => {
    const user = await UserModel.create({
      username: `u_${Date.now()}`,
      email: `u_${Date.now()}@example.com`,
      password: await hashPassword("correct-password"),
    });

    await expect(
      service.deleteAccount(user._id.toString(), "wrong-password"),
    ).rejects.toThrow(/incorrect password/i);

    const stillThere = await UserModel.findById(user._id).exec();
    expect(stillThere?.isDeleted).toBe(false);
  });

  it("anonymises the profile, soft-deletes, and logs out everywhere", async () => {
    const user = await UserModel.create({
      username: `alice_${Date.now()}`,
      email: `alice_${Date.now()}@example.com`,
      firstName: "Alice",
      lastName: "Smith",
      password: await hashPassword("correct-password"),
      tokenVersion: 3,
    });
    const other = await UserModel.create({
      username: `bob_${Date.now()}`,
      password: "hashed",
    });
    await SessionModel.create({
      userId: user._id,
      refreshTokenHash: "somehash",
      familyId: "fam1",
    });

    await service.deleteAccount(user._id.toString(), "correct-password");

    const updated = await UserModel.findById(user._id).exec();
    expect(updated?.isDeleted).toBe(true);
    expect(updated?.firstName).toBe("Deleted");
    expect(updated?.lastName).toBe("User");
    expect(updated?.username).toBe(`deleted_${user._id.toString()}`);
    expect(updated?.tokenVersion).toBe(4);
    expect(invalidateMock).toHaveBeenCalledWith(user._id.toString());

    const session = await SessionModel.findOne({ userId: user._id }).exec();
    expect(session?.revokedAt).toBeTruthy();

    await other.deleteOne();
  });

  it("removes memberships and blocks in both directions", async () => {
    const user = await UserModel.create({
      username: `carol_${Date.now()}`,
      password: await hashPassword("correct-password"),
    });
    const stranger = new Types.ObjectId();

    await ChatMembersModel.create({
      channelId: "some-channel",
      userId: user._id.toString(),
      role: "member",
    });
    await BlockModel.create({ blockerId: user._id, blockedId: stranger });
    await BlockModel.create({ blockerId: stranger, blockedId: user._id });

    await service.deleteAccount(user._id.toString(), "correct-password");

    expect(
      await ChatMembersModel.countDocuments({ userId: user._id.toString() }),
    ).toBe(0);
    expect(
      await BlockModel.countDocuments({
        $or: [{ blockerId: user._id }, { blockedId: user._id }],
      }),
    ).toBe(0);
  });

  it("deletes owned clips/packs/wallpaper and releases their MediaAsset refs", async () => {
    const user = await UserModel.create({
      username: `dave_${Date.now()}`,
      password: await hashPassword("correct-password"),
    });

    const clipAsset = await mediaService.ingestImage(
      ONE_PIXEL_GIF,
      user._id.toString(),
    );
    await ClipModel.create({ ownerId: user._id, mediaId: clipAsset._id });

    const stickerAsset = await mediaService.ingestImage(
      Buffer.concat([ONE_PIXEL_GIF, Buffer.from([1])]),
      user._id.toString(),
    );
    const pack = await PackModel.create({
      type: PackType.STICKER,
      name: "Pack",
      slug: `pack-${Date.now()}`,
      ownerId: user._id,
    });
    await PackItemModel.create({ packId: pack._id, mediaId: stickerAsset._id });
    // Owning a pack implies having it (PacksService.create auto-subscribes) — mirror that here.
    await PackSubscriptionModel.create({
      userId: user._id.toString(),
      packId: pack._id,
    });

    const wallpaperAsset = await mediaService.ingestImage(
      Buffer.concat([ONE_PIXEL_GIF, Buffer.from([2])]),
      user._id.toString(),
    );
    await WallpaperModel.create({
      ownerId: user._id,
      channelId: null,
      type: WallpaperType.IMAGE,
      mediaUrl: "https://example.com/w.jpg",
      thumbnailUrl: null,
      blur: 0,
      dim: 0,
      brightness: 100,
      fitMode: WallpaperFitMode.COVER,
      parallax: false,
      duration: null,
      videoStartSec: 0,
      originalFilename: null,
      mediaId: wallpaperAsset._id,
    });

    await service.deleteAccount(user._id.toString(), "correct-password");

    expect(await ClipModel.countDocuments({ ownerId: user._id })).toBe(0);
    expect(await PackModel.countDocuments({ ownerId: user._id })).toBe(0);
    expect(await PackItemModel.countDocuments({ packId: pack._id })).toBe(0);
    expect(
      await PackSubscriptionModel.countDocuments({ packId: pack._id }),
    ).toBe(0);
    expect(await WallpaperModel.countDocuments({ ownerId: user._id })).toBe(0);

    for (const asset of [clipAsset, stickerAsset, wallpaperAsset]) {
      const refreshed = await MediaAssetModel.findById(asset._id).exec();
      expect(refreshed?.refCount).toBe(0);
    }
  });
});
