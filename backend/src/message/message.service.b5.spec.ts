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
import { ChatType, UserRole } from "src/enum/base.enum";
import type { MessageService as MessageServiceType } from "./message.service";
import type { EventEmitter2 } from "eventemitter2";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("MessageService (B5: reactions, read receipts, hiddenAt, sanitization)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MessageModel: Model<Message>;
  let MessageReactionModel: Model<MessageReaction>;
  let ChatMembersModel: Model<ChatMembers>;
  let ChatModel: Model<Chat>;
  let UserModel: Model<User>;
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

    const { MessageService } = await import("./message.service");
    const fakeEmitter = {
      emit: jest.fn(),
      emitAsync: jest.fn().mockResolvedValue([]),
    } as unknown as EventEmitter2;
    // Only the emoji-reaction path is exercised in this file, which never calls into
    // PacksService — a stub that throws if invoked is enough to catch an accidental
    // packItemId path being added here without also stubbing real behavior.
    const fakePacksService = {
      resolveItemForUse: jest.fn(() => {
        throw new Error(
          "resolveItemForUse should not be called from these tests",
        );
      }),
    } as unknown as import("src/packs/packs.service").PacksService;
    // None of these tests send an attachment with attachmentMediaIds, so
    // buildAttachmentMeta's `MediaAsset.find` short-circuits before ever
    // reaching this model — a stub that throws if invoked is enough to
    // catch that assumption breaking silently.
    const fakeMediaAssetModel = {
      find: jest.fn(() => {
        throw new Error(
          "MediaAsset.find should not be called from these tests",
        );
      }),
    } as unknown as import("mongoose").Model<
      import("src/media/schema/media-asset.schema").MediaAsset
    >;
    service = new MessageService(
      MessageModel,
      MessageReactionModel,
      ChatMembersModel,
      ChatModel,
      UserModel,
      fakeMediaAssetModel,
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
      memberIds.map(userId => ({
        channelId,
        userId,
        role: UserRole.MEMBER,
      })),
    );
    return channelId;
  }

  /** `create()` looks up the sender's own User doc for the response's `senderId` view. */
  async function makeSenderUser(userId: string) {
    await UserModel.create({
      _id: new Types.ObjectId(userId),
      username: `user${userId.slice(-6)}`,
      email: `${userId.slice(-6)}@example.com`,
      password: "hashed",
    });
  }

  describe("toggleReaction", () => {
    it("adds then removes the same emoji (toggle)", async () => {
      const userId = new Types.ObjectId().toString();
      const senderId = new Types.ObjectId();
      const channelId = await makeGroupWithMembers([userId]);
      const message = await MessageModel.create({
        channelId,
        senderId,
        content: "hi",
      });

      const added = await service.toggleReaction(
        message._id.toString(),
        userId,
        "👍",
      );
      expect(added.action).toBe("added");
      expect(added.reactions).toEqual([
        {
          emoji: "👍",
          packItemId: null,
          relativePath: null,
          packId: null,
          count: 1,
          me: true,
        },
      ]);

      const removed = await service.toggleReaction(
        message._id.toString(),
        userId,
        "👍",
      );
      expect(removed.action).toBe("removed");
      expect(removed.reactions).toEqual([]);
    });

    it("counts multiple users reacting with the same emoji, and reports `me` per caller", async () => {
      const userA = new Types.ObjectId().toString();
      const userB = new Types.ObjectId().toString();
      const senderId = new Types.ObjectId();
      const channelId = await makeGroupWithMembers([userA, userB]);
      const message = await MessageModel.create({
        channelId,
        senderId,
        content: "hi",
      });

      await service.toggleReaction(message._id.toString(), userA, "🔥");
      const fromB = await service.toggleReaction(
        message._id.toString(),
        userB,
        "🔥",
      );

      expect(fromB.reactions).toEqual([
        {
          emoji: "🔥",
          packItemId: null,
          relativePath: null,
          packId: null,
          count: 2,
          me: true,
        },
      ]);

      const grouped = await (
        service as unknown as {
          getReactionsForMessages: (
            ids: string[],
            userId: string,
          ) => Promise<Map<string, unknown>>;
        }
      ).getReactionsForMessages([message._id.toString()], userA);
      expect(grouped.get(message._id.toString())).toEqual([
        {
          emoji: "🔥",
          packItemId: null,
          relativePath: null,
          packId: null,
          count: 2,
          me: true,
        },
      ]);
    });

    it("rejects a non-member", async () => {
      const senderId = new Types.ObjectId();
      const channelId = await makeGroupWithMembers([
        new Types.ObjectId().toString(),
      ]);
      const message = await MessageModel.create({
        channelId,
        senderId,
        content: "hi",
      });

      await expect(
        service.toggleReaction(
          message._id.toString(),
          new Types.ObjectId().toString(),
          "👍",
        ),
      ).rejects.toThrow(/access denied/i);
    });

    it("enforces the cap on distinct emojis per message", async () => {
      const userId = new Types.ObjectId().toString();
      const senderId = new Types.ObjectId();
      const channelId = await makeGroupWithMembers([userId]);
      const message = await MessageModel.create({
        channelId,
        senderId,
        content: "hi",
      });

      const emojis = Array.from({ length: 20 }, (_, i) => `e${i}`);
      for (const emoji of emojis) {
        await service.toggleReaction(message._id.toString(), userId, emoji);
      }

      await expect(
        service.toggleReaction(message._id.toString(), userId, "one-too-many"),
      ).rejects.toThrow(/maximum/i);
    });
  });

  describe("hiddenAt filtering (B5: replaces bulk deletedFor writes on leave)", () => {
    it("findAll excludes messages created before the member's hiddenAt pointer", async () => {
      const userId = new Types.ObjectId().toString();
      const senderId = new Types.ObjectId();
      const channelId = await makeGroupWithMembers([userId]);

      await MessageModel.create({
        channelId,
        senderId,
        content: "before leaving",
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      });
      await ChatMembersModel.updateOne(
        { channelId, userId },
        { $set: { hiddenAt: new Date("2024-01-02T00:00:00.000Z") } },
      );
      await MessageModel.create({
        channelId,
        senderId,
        content: "after rejoining",
        createdAt: new Date("2024-01-03T00:00:00.000Z"),
      });

      const result = await service.findAll(channelId, userId);
      expect(result.map(m => m.content)).toEqual(["after rejoining"]);
    });
  });

  describe("markAsRead", () => {
    it("only moves the read pointer forward", async () => {
      const userId = new Types.ObjectId().toString();
      const senderId = new Types.ObjectId();
      const channelId = await makeGroupWithMembers([userId]);
      const older = await MessageModel.create({
        channelId,
        senderId,
        content: "one",
      });
      const newer = await MessageModel.create({
        channelId,
        senderId,
        content: "two",
      });
      const pointer = async () =>
        (await ChatMembersModel.findOne({ channelId, userId }).lean())
          ?.lastReadMessageId;

      await service.markAsRead(channelId, userId, newer._id.toString());
      expect(await pointer()).toBe(newer._id.toString());
      // A stale client marking the older message read must not pull it back.
      await service.markAsRead(channelId, userId, older._id.toString());
      expect(await pointer()).toBe(newer._id.toString());
    });
  });

  describe("content sanitization + empty-edit rejection", () => {
    it("strips control characters from a new message's content", async () => {
      const userId = new Types.ObjectId().toString();
      const channelId = await makeGroupWithMembers([userId]);
      await makeSenderUser(userId);

      const created = await service.create(
        {
          channelId,
          content: "hi\x00\x07there",
        },
        userId,
      );
      expect(created.content).toBe("hithere");
    });

    it("rejects an edit that is empty after sanitization", async () => {
      const userId = new Types.ObjectId().toString();
      const channelId = await makeGroupWithMembers([userId]);
      const message = await MessageModel.create({
        channelId,
        senderId: new Types.ObjectId(userId),
        content: "original",
      });

      await expect(
        service.update(message._id.toString(), { content: "\x00\x01" }, userId),
      ).rejects.toThrow(/cannot be empty/i);
    });
  });

  describe("create(): durationSec/waveform/originalFilename/forwardFrom/replySnapshot", () => {
    it("persists voice duration and waveform", async () => {
      const userId = new Types.ObjectId().toString();
      const channelId = await makeGroupWithMembers([userId]);
      await makeSenderUser(userId);

      const created = await service.create(
        {
          channelId,
          content: "voice note",
          durationSec: 12,
          waveform: [0.1, 0.5, 0.9],
        },
        userId,
      );
      expect(created.durationSec).toBe(12);
      expect(created.waveform).toEqual([0.1, 0.5, 0.9]);
    });

    it("persists originalFilename for a file message", async () => {
      const userId = new Types.ObjectId().toString();
      const channelId = await makeGroupWithMembers([userId]);
      await makeSenderUser(userId);

      const created = await service.create(
        {
          channelId,
          content: "a file",
          originalFilename: "report.pdf",
        },
        userId,
      );
      expect(created.originalFilename).toBe("report.pdf");
    });

    it("builds a replySnapshot without needing to populate replyTo on read", async () => {
      const userId = new Types.ObjectId().toString();
      const channelId = await makeGroupWithMembers([userId]);
      await makeSenderUser(userId);
      const original = await MessageModel.create({
        channelId,
        senderId: new Types.ObjectId(userId),
        content: "original message",
      });

      const reply = await service.create(
        {
          channelId,
          content: "a reply",
          replyTo: original._id.toString(),
        },
        userId,
      );
      expect(reply.replySnapshot).toMatchObject({
        id: original._id.toString(),
        snippet: "original message",
        messageType: "text",
      });
    });
  });
});
