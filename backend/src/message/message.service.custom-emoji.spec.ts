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
import { ForbiddenException } from "@nestjs/common";
import { privacyServiceFor } from "src/common/testing/privacy";

const EMOJI_ITEM = new Types.ObjectId().toString();
const STICKER_ITEM = new Types.ObjectId().toString();

describe("MessageService — inline animated emoji (customEmoji entities)", () => {
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
      // eslint-disable-next-line @typescript-eslint/require-await -- the real method is async; throwing must reject
      resolveItemForUse: jest.fn(async (itemId: string) => {
        if (itemId === EMOJI_ITEM)
          return {
            packId: "emoji-pack",
            relativePath: "h1/original.webp",
            thumbPath: "h1/pack-160.webp",
            stillPath: "h1/pack-still-160.webp",
            animated: true,
            packType: "emoji",
          };
        if (itemId === STICKER_ITEM)
          return {
            packId: "sticker-pack",
            relativePath: "h2/original.png",
            thumbPath: "h2/pack-160.webp",
            stillPath: "h2/pack-160.webp",
            animated: false,
            packType: "sticker",
          };
        throw new ForbiddenException("Add this pack before using it");
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

  async function setup() {
    const userId = new Types.ObjectId().toString();
    const channelId = await makeGroupWithMembers([userId]);
    await makeSenderUser(userId);
    return { userId, channelId };
  }

  it("stores resolved entities (packId/relativePath from the server, not the client)", async () => {
    const { userId, channelId } = await setup();
    const content = "Hi 😂 there";
    const created = await service.create(
      {
        channelId,
        content,
        customEmoji: [{ offset: 3, length: 2, packItemId: EMOJI_ITEM }],
      },
      userId,
    );
    expect(created.customEmoji).toEqual([
      // The small animated variant + its still, never the 512px original.
      {
        offset: 3,
        length: 2,
        packItemId: EMOJI_ITEM,
        packId: "emoji-pack",
        relativePath: "h1/pack-160.webp",
        stillPath: "h1/pack-still-160.webp",
      },
    ]);
    const stored = await MessageModel.findById(created._id).lean();
    expect(stored!.customEmoji).toHaveLength(1);
  });

  it("shifts offsets by the whitespace the server trims off the front", async () => {
    const { userId, channelId } = await setup();
    const created = await service.create(
      {
        channelId,
        content: "   😂 ok",
        customEmoji: [{ offset: 3, length: 2, packItemId: EMOJI_ITEM }],
      },
      userId,
    );
    expect(created.content).toBe("😂 ok");
    expect(created.customEmoji[0].offset).toBe(0);
  });

  it("drops out-of-range, whitespace, and overlapping spans instead of drawing them in the wrong place", async () => {
    const { userId, channelId } = await setup();
    const created = await service.create(
      {
        channelId,
        content: "😂😂 x",
        customEmoji: [
          { offset: 0, length: 2, packItemId: EMOJI_ITEM },
          { offset: 1, length: 2, packItemId: EMOJI_ITEM }, // overlaps the first
          { offset: 4, length: 1, packItemId: EMOJI_ITEM }, // whitespace
          { offset: 40, length: 2, packItemId: EMOJI_ITEM }, // past the end
        ],
      },
      userId,
    );
    expect(
      created.customEmoji.map((e: { offset: number }) => e.offset),
    ).toEqual([0]);
  });

  it("rejects a sticker placed inline, and an item from a pack the sender doesn't have", async () => {
    const { userId, channelId } = await setup();
    await expect(
      service.create(
        {
          channelId,
          content: "a 🙂",
          customEmoji: [{ offset: 2, length: 2, packItemId: STICKER_ITEM }],
        },
        userId,
      ),
    ).rejects.toThrow(/Only animated emoji/);
    await expect(
      service.create(
        {
          channelId,
          content: "a 🙂",
          customEmoji: [
            {
              offset: 2,
              length: 2,
              packItemId: new Types.ObjectId().toString(),
            },
          ],
        },
        userId,
      ),
    ).rejects.toThrow(/Add this pack/);
  });

  it("ignores entities on non-text messages", async () => {
    const { userId, channelId } = await setup();
    const created = await service.create(
      {
        channelId,
        content: "😂",
        type: "image" as never,
        attachments: ["http://x/y.jpg"],
        customEmoji: [{ offset: 0, length: 2, packItemId: EMOJI_ITEM }],
      },
      userId,
    );
    expect(created.customEmoji).toEqual([]);
  });

  it("edit re-resolves entities, and clears them when none are sent", async () => {
    const { userId, channelId } = await setup();
    const created = await service.create(
      {
        channelId,
        content: "😂",
        customEmoji: [{ offset: 0, length: 2, packItemId: EMOJI_ITEM }],
      },
      userId,
    );
    const edited = await service.update(
      String(created._id),
      {
        content: "ok 😂",
        customEmoji: [{ offset: 3, length: 2, packItemId: EMOJI_ITEM }],
      },
      userId,
    );
    expect(
      (edited as { customEmoji: { offset: number }[] }).customEmoji[0].offset,
    ).toBe(3);
    const cleared = await service.update(
      String(created._id),
      { content: "plain" },
      userId,
    );
    expect((cleared as { customEmoji: unknown[] }).customEmoji).toEqual([]);
  });
});
