import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Message, MessageSchema } from "./schema/message.schema";
import {
  MessageReaction,
  MessageReactionSchema,
} from "./schema/message-reaction.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import {
  MediaAsset,
  MediaAssetSchema,
} from "src/media/schema/media-asset.schema";
import { ChatType, UserRole } from "src/enum/base.enum";
import type { MessageService as MessageServiceType } from "./message.service";
import type { EventEmitter2 } from "eventemitter2";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("MessageService.create — attachmentMeta (blurhash/width/height from a real MediaAsset row)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MessageModel: Model<Message>;
  let MessageReactionModel: Model<MessageReaction>;
  let ChatMembersModel: Model<ChatMembers>;
  let ChatModel: Model<Chat>;
  let UserModel: Model<User>;
  let MediaAssetModel: Model<MediaAsset>;
  let service: MessageServiceType;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    MessageModel = connection.model(Message.name, MessageSchema);
    MessageReactionModel = connection.model(
      MessageReaction.name,
      MessageReactionSchema,
    );
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    UserModel = connection.model(User.name, UserSchema);
    MediaAssetModel = connection.model(MediaAsset.name, MediaAssetSchema);

    const { MessageService } = await import("./message.service");
    const fakeEmitter = { emit: jest.fn() } as unknown as EventEmitter2;
    const fakePacksService = {
      resolveItemForUse: jest.fn(() => {
        throw new Error(
          "resolveItemForUse should not be called from these tests",
        );
      }),
    } as unknown as import("src/packs/packs.service").PacksService;
    service = new MessageService(
      MessageModel,
      MessageReactionModel,
      ChatMembersModel,
      ChatModel,
      UserModel,
      MediaAssetModel,
      fakeEmitter,
      fakePacksService,
      privacyServiceFor(connection),
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all([
      MessageModel.deleteMany({}),
      MessageReactionModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
      ChatModel.deleteMany({}),
      UserModel.deleteMany({}),
      MediaAssetModel.deleteMany({}),
    ]);
  });

  async function makeGroupWithMembers(memberIds: string[]) {
    const chat = await ChatModel.create({
      link: `test-${Date.now()}-${Math.random()}`,
      name: "Test Group",
      type: ChatType.GROUP,
    });
    const channelId = chat._id.toString();
    await ChatMembersModel.insertMany(
      memberIds.map(userId => ({ channelId, userId, role: UserRole.MEMBER })),
    );
    return channelId;
  }

  async function makeSenderUser(userId: string) {
    await UserModel.create({
      _id: new Types.ObjectId(userId),
      username: `user${userId.slice(-6)}`,
      email: `${userId.slice(-6)}@example.com`,
      password: "hashed",
    });
  }

  async function makeMediaAsset(overrides: Partial<MediaAsset> = {}) {
    return MediaAssetModel.create({
      hash: `hash-${Date.now()}-${Math.random()}`,
      kind: "image",
      mimeType: "image/jpeg",
      sizeBytes: 12_345,
      width: 800,
      height: 600,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      variants: {
        original: "x/original.jpg",
        web: "x/web.jpg",
        thumb: "x/thumb.jpg",
      },
      ownerId: new Types.ObjectId(),
      ...overrides,
    });
  }

  it("builds attachmentMeta keyed by URL from the real MediaAsset row, not from anything the client claims", async () => {
    const userId = new Types.ObjectId().toString();
    const channelId = await makeGroupWithMembers([userId]);
    await makeSenderUser(userId);
    const asset = await makeMediaAsset();

    const created = await service.create(
      {
        channelId,
        content: "",
        type: "image" as never,
        attachments: ["https://cdn.example.com/x/web.jpg"],
        attachmentMediaIds: [asset._id.toString()],
      },
      userId,
    );

    expect(created.attachmentMeta).toEqual({
      "https://cdn.example.com/x/web.jpg": {
        mediaId: asset._id.toString(),
        width: 800,
        height: 600,
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      },
    });
  });

  it("is null when no attachmentMediaIds are given at all (plain text message, or a legacy client)", async () => {
    const userId = new Types.ObjectId().toString();
    const channelId = await makeGroupWithMembers([userId]);
    await makeSenderUser(userId);

    const created = await service.create(
      { channelId, content: "just text" },
      userId,
    );
    expect(created.attachmentMeta).toBeNull();
  });

  it("leaves an attachment out of attachmentMeta (not the whole send failing) when its id doesn't resolve to a real row", async () => {
    const userId = new Types.ObjectId().toString();
    const channelId = await makeGroupWithMembers([userId]);
    await makeSenderUser(userId);

    const created = await service.create(
      {
        channelId,
        content: "",
        type: "image" as never,
        attachments: ["https://cdn.example.com/gone.jpg"],
        attachmentMediaIds: [new Types.ObjectId().toString()], // well-formed id, no such row
      },
      userId,
    );

    expect(created.attachmentMeta).toBeNull();
    expect(created.attachments).toEqual(["https://cdn.example.com/gone.jpg"]);
  });

  it("matches multiple attachments to their own media rows by array position", async () => {
    const userId = new Types.ObjectId().toString();
    const channelId = await makeGroupWithMembers([userId]);
    await makeSenderUser(userId);
    const first = await makeMediaAsset({
      width: 100,
      height: 100,
      blurhash: "first",
    });
    const second = await makeMediaAsset({
      width: 200,
      height: 200,
      blurhash: "second",
    });

    const created = await service.create(
      {
        channelId,
        content: "",
        type: "image" as never,
        attachments: [
          "https://cdn.example.com/a.jpg",
          "https://cdn.example.com/b.jpg",
        ],
        attachmentMediaIds: [first._id.toString(), second._id.toString()],
      },
      userId,
    );

    expect(
      created.attachmentMeta?.["https://cdn.example.com/a.jpg"].blurhash,
    ).toBe("first");
    expect(
      created.attachmentMeta?.["https://cdn.example.com/b.jpg"].blurhash,
    ).toBe("second");
  });

  it("marks the video cells of a mixed photo/video album with their kind, length and poster", async () => {
    const userId = new Types.ObjectId().toString();
    const channelId = await makeGroupWithMembers([userId]);
    await makeSenderUser(userId);
    const photo = await makeMediaAsset();
    const video = await makeMediaAsset({
      kind: "video",
      mimeType: "video/mp4",
      durationSec: 12.5,
      variants: { original: "v/original.mp4", poster: "v/poster.jpg" },
    });

    const created = await service.create(
      {
        channelId,
        content: "",
        type: "image" as never,
        attachments: [
          "/uploads/media/x/original.jpg",
          "/uploads/media/v/original.mp4",
        ],
        attachmentMediaIds: [photo._id.toString(), video._id.toString()],
      },
      userId,
    );

    expect(
      created.attachmentMeta?.["/uploads/media/x/original.jpg"].kind,
    ).toBeUndefined();
    expect(
      created.attachmentMeta?.["/uploads/media/v/original.mp4"],
    ).toMatchObject({
      kind: "video",
      durationSec: 12.5,
      posterUrl: "/uploads/media/v/poster.jpg",
    });
  });

  it("stores each file's own name in a file group", async () => {
    const userId = new Types.ObjectId().toString();
    const channelId = await makeGroupWithMembers([userId]);
    await makeSenderUser(userId);
    const a = await makeMediaAsset({
      kind: "file",
      mimeType: "application/pdf",
    });
    const b = await makeMediaAsset({
      kind: "file",
      mimeType: "application/zip",
    });

    const created = await service.create(
      {
        channelId,
        content: "گزارش",
        type: "file" as never,
        attachments: ["/uploads/files/a", "/uploads/files/b"],
        attachmentMediaIds: [a._id.toString(), b._id.toString()],
        attachmentNames: ["report.pdf", "data.zip"],
        originalFilename: "report.pdf",
      },
      userId,
    );

    expect(created.attachmentMeta?.["/uploads/files/a"].fileName).toBe(
      "report.pdf",
    );
    expect(created.attachmentMeta?.["/uploads/files/b"].fileName).toBe(
      "data.zip",
    );
    expect(created.content).toBe("گزارش");
  });

  it("a forward copies the original's attachmentMeta rather than re-resolving it", async () => {
    const userId = new Types.ObjectId().toString();
    const channelId = await makeGroupWithMembers([userId]);
    await makeSenderUser(userId);
    const asset = await makeMediaAsset();

    const original = await service.create(
      {
        channelId,
        content: "",
        type: "image" as never,
        attachments: ["https://cdn.example.com/x/web.jpg"],
        attachmentMediaIds: [asset._id.toString()],
      },
      userId,
    );

    const forwarded = await service.create(
      { channelId, content: "", forwardFrom: original._id.toString() },
      userId,
    );

    expect(forwarded.attachmentMeta).toEqual(original.attachmentMeta);
  });
});
