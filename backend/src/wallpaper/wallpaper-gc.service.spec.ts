import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Wallpaper, WallpaperSchema } from "./schema/wallpaper.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import {
  MediaAsset,
  MediaAssetSchema,
} from "src/media/schema/media-asset.schema";
import { WallpaperGcService } from "./wallpaper-gc.service";
import { WallpaperFitMode, WallpaperType } from "./schema/wallpaper.schema";

describe("WallpaperGcService (B9: nightly GC of unreferenced wallpaper docs)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let WallpaperModel: Model<Wallpaper>;
  let UserModel: Model<User>;
  let ChatMembersModel: Model<ChatMembers>;
  let MediaAssetModel: Model<MediaAsset>;
  let service: WallpaperGcService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    WallpaperModel = connection.model(Wallpaper.name, WallpaperSchema);
    UserModel = connection.model(User.name, UserSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    MediaAssetModel = connection.model(MediaAsset.name, MediaAssetSchema);
    await WallpaperModel.createIndexes();

    service = new WallpaperGcService(
      WallpaperModel,
      UserModel,
      ChatMembersModel,
      MediaAssetModel,
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all([
      WallpaperModel.deleteMany({}),
      UserModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
      MediaAssetModel.deleteMany({}),
    ]);
  });

  function makeWallpaper(overrides: Partial<Wallpaper> = {}) {
    return WallpaperModel.create({
      ownerId: new Types.ObjectId(),
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
      mediaId: null,
      ...overrides,
    });
  }

  it("leaves a wallpaper referenced by a user's globalWallpaperId untouched", async () => {
    const owner = await UserModel.create({
      username: `u_${Date.now()}`,
      password: "x",
    });
    const wp = await makeWallpaper({ ownerId: owner._id });
    await UserModel.updateOne(
      { _id: owner._id },
      { $set: { globalWallpaperId: wp._id } },
    ).exec();

    const result = await service.runGc();
    expect(result.deleted).toBe(0);
    await expect(WallpaperModel.findById(wp._id).exec()).resolves.toBeTruthy();
  });

  it("leaves a wallpaper referenced by a chatMembers.chatWallpaperId untouched", async () => {
    const wp = await makeWallpaper();
    await ChatMembersModel.create({
      channelId: "some-channel",
      userId: "some-user",
      role: "member",
      chatWallpaperId: wp._id,
    });

    const result = await service.runGc();
    expect(result.deleted).toBe(0);
    await expect(WallpaperModel.findById(wp._id).exec()).resolves.toBeTruthy();
  });

  it("deletes an orphaned wallpaper and releases its MediaAsset reference", async () => {
    const asset = await MediaAssetModel.create({
      hash: `hash_${Date.now()}`,
      kind: "image",
      mimeType: "image/jpeg",
      sizeBytes: 100,
      variants: { original: "x/original.jpg" },
      ownerId: new Types.ObjectId(),
      refCount: 1,
    });
    const wp = await makeWallpaper({ mediaId: asset._id });

    const result = await service.runGc();
    expect(result.deleted).toBe(1);
    await expect(WallpaperModel.findById(wp._id).exec()).resolves.toBeNull();

    const refreshedAsset = await MediaAssetModel.findById(asset._id).exec();
    expect(refreshedAsset?.refCount).toBe(0);
  });

  it("never takes refCount below zero", async () => {
    const asset = await MediaAssetModel.create({
      hash: `hash_${Date.now()}_2`,
      kind: "image",
      mimeType: "image/jpeg",
      sizeBytes: 100,
      variants: { original: "x/original.jpg" },
      ownerId: new Types.ObjectId(),
      refCount: 0,
    });
    await makeWallpaper({ mediaId: asset._id });

    await service.runGc();
    const refreshedAsset = await MediaAssetModel.findById(asset._id).exec();
    expect(refreshedAsset?.refCount).toBe(0);
  });
});
