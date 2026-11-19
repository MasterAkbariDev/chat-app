import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import {
  MessageReaction,
  MessageReactionSchema,
} from "src/message/schema/message-reaction.schema";
import { MessageService } from "src/message/message.service";
import {
  ModerationLog,
  ModerationLogSchema,
} from "./schema/moderation-log.schema";
import { ModerationLogService } from "./moderation-log.service";
import type { ChatGateway } from "src/gateway/chat.gateway";
import type { ModerationService as ModerationServiceType } from "./moderation.service";
import type { EventEmitter2 } from "eventemitter2";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("ModerationService (B10: admin moderation actions)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let ChatModel: Model<Chat>;
  let ChatMembersModel: Model<ChatMembers>;
  let MessageModel: Model<Message>;
  let MessageReactionModel: Model<MessageReaction>;
  let ModerationLogModel: Model<ModerationLog>;
  let service: ModerationServiceType;

  const broadcastNewMessageMock = jest.fn();
  const notifyMessageDeletedMock = jest.fn();
  const fakeGateway = {
    broadcastNewMessage: broadcastNewMessageMock,
    notifyMessageDeleted: notifyMessageDeletedMock,
  } as unknown as ChatGateway;
  const invalidateMock = jest.fn();
  const fakeTokenCache = { invalidate: invalidateMock } as unknown as {
    invalidate: (userId: string) => Promise<void>;
  };

  const adminId = new Types.ObjectId().toString();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    MessageModel = connection.model(Message.name, MessageSchema);
    MessageReactionModel = connection.model(
      MessageReaction.name,
      MessageReactionSchema,
    );
    ModerationLogModel = connection.model(
      ModerationLog.name,
      ModerationLogSchema,
    );

    const fakeEmitter = { emit: jest.fn() } as unknown as EventEmitter2;
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
    const messageService = new MessageService(
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
    const moderationLog = new ModerationLogService(ModerationLogModel);

    // ModerationService transitively imports ChatGateway, whose @WebSocketGateway decorator
    // reads CORS_ORIGIN at module-load time — set it before the (dynamic) first import.
    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";
    const { ModerationService } = await import("./moderation.service");

    service = new ModerationService(
      UserModel,
      ChatModel,
      ChatMembersModel,
      MessageModel,
      messageService,
      fakeGateway,
      fakeTokenCache as never,
      moderationLog,
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await Promise.all([
      UserModel.deleteMany({}),
      ChatModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
      MessageModel.deleteMany({}),
      ModerationLogModel.deleteMany({}),
    ]);
  });

  describe("suspendUser / unsuspendUser", () => {
    it("sets suspendedUntil to the given date and invalidates the token cache", async () => {
      const user = await UserModel.create({ username: "u1", password: "x" });
      const until = new Date(Date.now() + 60_000).toISOString();

      await service.suspendUser(adminId, user._id.toString(), until, "spam");

      const updated = await UserModel.findById(user._id).exec();
      expect(updated?.suspendedUntil?.toISOString()).toBe(until);
      expect(invalidateMock).toHaveBeenCalledWith(user._id.toString());

      const log = await ModerationLogModel.findOne({
        targetId: user._id.toString(),
      }).exec();
      expect(log?.action).toBe("user.suspend");
    });

    it("suspends indefinitely when no until date is given", async () => {
      const user = await UserModel.create({ username: "u2", password: "x" });
      await service.suspendUser(
        adminId,
        user._id.toString(),
        undefined,
        "abuse",
      );
      const updated = await UserModel.findById(user._id).exec();
      expect(updated?.suspendedUntil?.getFullYear()).toBeGreaterThan(9000);
    });

    it("unsuspend clears suspendedUntil", async () => {
      const user = await UserModel.create({
        username: "u3",
        password: "x",
        suspendedUntil: new Date(Date.now() + 60_000),
      });
      await service.unsuspendUser(adminId, user._id.toString());
      const updated = await UserModel.findById(user._id).exec();
      expect(updated?.suspendedUntil).toBeNull();
    });

    it("rejects an unknown user", async () => {
      await expect(
        service.suspendUser(
          adminId,
          new Types.ObjectId().toString(),
          undefined,
          "x",
        ),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("warnUser", () => {
    it("creates the Moderation account once and DMs the target", async () => {
      const target = await UserModel.create({
        username: "target1",
        password: "x",
      });

      await service.warnUser(
        adminId,
        target._id.toString(),
        "please stop that",
      );
      await service.warnUser(adminId, target._id.toString(), "second warning");

      const moderationAccounts = await UserModel.countDocuments({
        username: "moderation",
      });
      expect(moderationAccounts).toBe(1); // lazily created once, reused after

      const chats = await ChatModel.countDocuments({
        link: `private-mod-${target._id.toString()}`,
      });
      expect(chats).toBe(1); // same DM reused for repeat warnings

      const messages = await MessageModel.find({})
        .sort({ createdAt: 1 })
        .exec();
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("please stop that");
      expect(messages[1].content).toBe("second warning");

      expect(broadcastNewMessageMock).toHaveBeenCalledTimes(2);
    });

    it("rejects an unknown user", async () => {
      await expect(
        service.warnUser(adminId, new Types.ObjectId().toString(), "hi"),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("hardHideMessage", () => {
    it("scrubs content, flags isDeleted, and notifies deletion", async () => {
      const sender = await UserModel.create({
        username: "sender1",
        password: "x",
      });
      const channelId = new Types.ObjectId().toString();
      const message = await MessageModel.create({
        channelId,
        senderId: sender._id,
        content: "something bad",
        type: "text",
      });

      await service.hardHideMessage(adminId, message._id.toString());

      const updated = await MessageModel.findById(message._id).exec();
      expect(updated?.isDeleted).toBe(true);
      expect(updated?.content).toBe("[removed by moderator]");
      expect(notifyMessageDeletedMock).toHaveBeenCalledWith(
        channelId,
        message._id.toString(),
        expect.objectContaining({ lastMessagePreview: null }),
      );
    });

    it("rejects an unknown message", async () => {
      await expect(
        service.hardHideMessage(adminId, new Types.ObjectId().toString()),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("lockChannel / unlockChannel", () => {
    it("toggles isLocked and logs each action distinctly", async () => {
      const chat = await ChatModel.create({
        link: "c1",
        type: "group",
        name: "Chat",
      });

      await service.lockChannel(adminId, chat._id.toString());
      expect((await ChatModel.findById(chat._id).exec())?.isLocked).toBe(true);

      await service.unlockChannel(adminId, chat._id.toString());
      expect((await ChatModel.findById(chat._id).exec())?.isLocked).toBe(false);

      const actions = (
        await ModerationLogModel.find({ targetId: chat._id.toString() })
          .sort({ at: 1 })
          .exec()
      ).map(l => l.action);
      expect(actions).toEqual(["channel.lock", "channel.unlock"]);
    });
  });

  describe("removeChannelMember", () => {
    it("marks the member as no longer joined", async () => {
      const channelId = new Types.ObjectId().toString();
      const userId = new Types.ObjectId().toString();
      await ChatMembersModel.create({ channelId, userId, role: "member" });

      await service.removeChannelMember(adminId, channelId, userId);

      const member = await ChatMembersModel.findOne({
        channelId,
        userId,
      }).exec();
      expect(member?.isJoined).toBe(false);
    });

    it("rejects removing a non-member", async () => {
      await expect(
        service.removeChannelMember(
          adminId,
          new Types.ObjectId().toString(),
          new Types.ObjectId().toString(),
        ),
      ).rejects.toThrow(/not a member/i);
    });
  });
});
