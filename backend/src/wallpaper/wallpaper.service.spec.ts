import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Wallpaper, WallpaperSchema } from "./schema/wallpaper.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import {
  MediaAsset,
  MediaAssetSchema,
} from "src/media/schema/media-asset.schema";
import { MediaService } from "src/media/media.service";
import { DiskMediaStorageService } from "src/media/storage/disk-media-storage.service";
import { WallpaperMediaService } from "./wallpaper-media.service";
import type { ChatGateway } from "src/gateway/chat.gateway";
import type { WallpaperService as WallpaperServiceType } from "./wallpaper.service";
import { ChatType } from "src/enum/base.enum";

const ONE_PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

describe("WallpaperService (B9: upsert-not-create, media via MediaService, membership guard)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let WallpaperModel: Model<Wallpaper>;
  let UserModel: Model<User>;
  let ChatMembersModel: Model<ChatMembers>;
  let ChatModel: Model<Chat>;
  let MessageModel: Model<Message>;
  let MediaAssetModel: Model<MediaAsset>;
  let mediaService: MediaService;
  let service: WallpaperServiceType;
  let tempRoot: string;

  const fakeGateway = {
    emitToUser: jest.fn(),
    broadcastNewMessage: jest.fn(),
  } as unknown as ChatGateway;

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "wallpaper-service-test-"));
    process.env.MEDIA_STORAGE_ROOT = tempRoot;

    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    WallpaperModel = connection.model(Wallpaper.name, WallpaperSchema);
    UserModel = connection.model(User.name, UserSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    MessageModel = connection.model(Message.name, MessageSchema);
    MediaAssetModel = connection.model(MediaAsset.name, MediaAssetSchema);
    await Promise.all([
      WallpaperModel.createIndexes(),
      MediaAssetModel.createIndexes(),
    ]);

    mediaService = new MediaService(
      MediaAssetModel,
      new DiskMediaStorageService(),
    );

    // WallpaperService transitively imports ChatGateway, whose @WebSocketGateway decorator
    // reads CORS_ORIGIN at module-load time — set it before the (dynamic) first import.
    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";
    const { WallpaperService } = await import("./wallpaper.service");

    service = new WallpaperService(
      WallpaperModel,
      UserModel,
      ChatMembersModel,
      ChatModel,
      MessageModel,
      new WallpaperMediaService(),
      mediaService,
      fakeGateway,
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.MEDIA_STORAGE_ROOT;
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await Promise.all([
      WallpaperModel.deleteMany({}),
      UserModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
      ChatModel.deleteMany({}),
      MessageModel.deleteMany({}),
      MediaAssetModel.deleteMany({}),
    ]);
  });

  async function makeUserAndChat() {
    const [owner, other] = await UserModel.create([
      { username: `owner_${Date.now()}`, password: "x" },
      { username: `other_${Date.now()}`, password: "x" },
    ]);
    const chat = await ChatModel.create({
      link: `chat_${Date.now()}`,
      type: ChatType.PRIVATE,
      name: "Test DM",
    });
    await ChatMembersModel.create([
      {
        channelId: chat._id.toString(),
        userId: owner._id.toString(),
        role: "member",
      },
      {
        channelId: chat._id.toString(),
        userId: other._id.toString(),
        role: "member",
      },
    ]);
    return { owner, other, chat };
  }

  function applyDto(mediaId?: string) {
    return {
      type: "image" as const,
      mediaUrl: "https://example.com/wall.jpg",
      ...(mediaId ? { mediaId } : {}),
    };
  }

  it("does not expose a decline method anymore (B9: 'remove decline')", () => {
    expect(
      (service as unknown as Record<string, unknown>).declineShared,
    ).toBeUndefined();
  });

  it("upserts in place instead of creating a new doc per apply (global scope)", async () => {
    const { owner } = await makeUserAndChat();

    await service.applyGlobal(owner._id.toString(), applyDto());
    await service.applyGlobal(owner._id.toString(), applyDto());
    await service.applyGlobal(owner._id.toString(), applyDto());

    const count = await WallpaperModel.countDocuments({
      ownerId: owner._id,
      channelId: null,
    });
    expect(count).toBe(1);
  });

  it("upserts in place instead of creating a new doc per apply (chat scope)", async () => {
    const { owner, chat } = await makeUserAndChat();

    await service.applyChat(
      owner._id.toString(),
      chat._id.toString(),
      applyDto(),
    );
    await service.applyChat(
      owner._id.toString(),
      chat._id.toString(),
      applyDto(),
    );

    const count = await WallpaperModel.countDocuments({
      ownerId: owner._id,
      channelId: chat._id.toString(),
    });
    expect(count).toBe(1);
  });

  it("releases the old MediaAsset reference when the scope's wallpaper is replaced", async () => {
    const { owner } = await makeUserAndChat();
    const assetA = await mediaService.ingestImage(
      ONE_PIXEL_GIF,
      owner._id.toString(),
    );
    const assetB = await mediaService.ingestImage(
      Buffer.concat([ONE_PIXEL_GIF, Buffer.from([0])]),
      owner._id.toString(),
    );

    await service.applyGlobal(
      owner._id.toString(),
      applyDto(assetA._id.toString()),
    );
    let refreshedA = await MediaAssetModel.findById(assetA._id).exec();
    expect(refreshedA?.refCount).toBe(1);

    await service.applyGlobal(
      owner._id.toString(),
      applyDto(assetB._id.toString()),
    );
    refreshedA = await MediaAssetModel.findById(assetA._id).exec();
    expect(refreshedA?.refCount).toBe(0);

    // Re-picking the earlier upload takes a reference again, and B's is released.
    const res = await service.applyGlobal(
      owner._id.toString(),
      applyDto(assetA._id.toString()),
    );
    expect(res.mediaId).toBe(assetA._id.toString());
    refreshedA = await MediaAssetModel.findById(assetA._id).exec();
    expect(refreshedA?.refCount).toBe(1);
    const refreshedB = await MediaAssetModel.findById(assetB._id).exec();
    expect(refreshedB?.refCount).toBe(0);
  });

  it("counts a reference per scope when one upload backs two wallpapers", async () => {
    const { owner, chat } = await makeUserAndChat();
    const asset = await mediaService.ingestImage(
      ONE_PIXEL_GIF,
      owner._id.toString(),
    );
    await service.applyGlobal(
      owner._id.toString(),
      applyDto(asset._id.toString()),
    );
    await service.applyChat(
      owner._id.toString(),
      chat._id.toString(),
      applyDto(asset._id.toString()),
    );
    const refreshed = await MediaAssetModel.findById(asset._id).exec();
    expect(refreshed?.refCount).toBe(2);
  });

  it("getChat is membership-guarded — a non-member is rejected", async () => {
    const { owner, chat } = await makeUserAndChat();
    await service.applyChat(
      owner._id.toString(),
      chat._id.toString(),
      applyDto(),
    );

    const stranger = new Types.ObjectId().toString();
    await expect(
      service.getChat(stranger, chat._id.toString()),
    ).rejects.toThrow(/not a member/i);
  });

  it("getEffective is membership-guarded through getChat", async () => {
    const { owner, chat } = await makeUserAndChat();
    await service.applyChat(
      owner._id.toString(),
      chat._id.toString(),
      applyDto(),
    );

    const stranger = new Types.ObjectId().toString();
    await expect(
      service.getEffective(stranger, chat._id.toString()),
    ).rejects.toThrow(/not a member/i);
  });

  it("getById allows the owner and other chat members, rejects strangers", async () => {
    const { owner, other, chat } = await makeUserAndChat();
    const applied = await service.applyChat(
      owner._id.toString(),
      chat._id.toString(),
      applyDto(),
    );
    const wallpaperId = applied.wallpaper.id;

    await expect(
      service.getById(wallpaperId, owner._id.toString()),
    ).resolves.toBeTruthy();
    await expect(
      service.getById(wallpaperId, other._id.toString()),
    ).resolves.toBeTruthy();

    const stranger = new Types.ObjectId().toString();
    await expect(service.getById(wallpaperId, stranger)).rejects.toThrow();
  });

  it("getById rejects a stranger reading someone else's global wallpaper", async () => {
    const { owner } = await makeUserAndChat();
    const applied = await service.applyGlobal(owner._id.toString(), applyDto());

    const stranger = new Types.ObjectId().toString();
    await expect(service.getById(applied.id, stranger)).rejects.toThrow(
      /cannot view/i,
    );
  });

  it("uploadImage routes through MediaService and returns a mediaId", async () => {
    const { owner } = await makeUserAndChat();
    const req = { headers: { host: "localhost:3000" } } as never;
    const file = {
      buffer: ONE_PIXEL_GIF,
      size: ONE_PIXEL_GIF.length,
    } as Express.Multer.File;

    const result = await service.uploadImage(owner._id.toString(), file, req);
    expect(result.mediaId).toBeTruthy();
    expect(result.url).toContain("/uploads/media/");

    const asset = await MediaAssetModel.findById(result.mediaId).exec();
    expect(asset).toBeTruthy();
  });
});
