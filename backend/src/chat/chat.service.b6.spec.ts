import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Chat, ChatSchema } from "./schema/chat.schema";
import { ChatMembers, ChatMembersSchema } from "./schema/chat-members.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import type { ChatGateway } from "src/gateway/chat.gateway";
import type { ChatService as ChatServiceType } from "./chat.service";
import type { EventEmitter2 } from "eventemitter2";
import { ChatType, UserRole } from "src/enum/base.enum";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("ChatService (B6: tags admin/owner-only, search excludes private chats)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatModel: Model<Chat>;
  let ChatMembersModel: Model<ChatMembers>;
  let UserModel: Model<User>;
  let MessageModel: Model<Message>;
  let service: ChatServiceType;

  const fakeGateway = {
    notifyNewChat: jest.fn().mockResolvedValue(undefined),
    notifyChatBanned: jest.fn(),
    notifyChannelRolesUpdated: jest.fn(),
    notifyUserMuted: jest.fn(),
  } as unknown as ChatGateway;
  const fakeEventEmitter = { emit: jest.fn() } as unknown as EventEmitter2;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ChatModel = connection.model(Chat.name, ChatSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    UserModel = connection.model(User.name, UserSchema);
    MessageModel = connection.model(Message.name, MessageSchema);

    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";
    const { ChatService } = await import("./chat.service");

    service = new ChatService(
      ChatModel,
      ChatMembersModel,
      UserModel,
      MessageModel,
      fakeGateway,
      fakeEventEmitter,
      privacyServiceFor(connection),
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all([
      ChatModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
    ]);
  });

  describe("setTags", () => {
    it("rejects a plain member", async () => {
      const chat = await ChatModel.create({
        link: `g-${new Types.ObjectId().toString()}`,
        type: ChatType.GROUP,
        name: "Group",
      });
      const userId = new Types.ObjectId().toString();
      await ChatMembersModel.create({
        channelId: chat._id.toString(),
        userId,
        role: UserRole.MEMBER,
      });

      await expect(
        service.setTags(chat._id.toString(), ["fun"], userId),
      ).rejects.toThrow(/only admins and owners/i);
    });

    it("allows an admin or owner", async () => {
      const chat = await ChatModel.create({
        link: `g-${new Types.ObjectId().toString()}`,
        type: ChatType.GROUP,
        name: "Group",
      });
      const ownerId = new Types.ObjectId().toString();
      await ChatMembersModel.create({
        channelId: chat._id.toString(),
        userId: ownerId,
        role: UserRole.OWNER,
      });

      const updated = await service.setTags(
        chat._id.toString(),
        ["fun", "sports"],
        ownerId,
      );
      expect(updated?.tags).toEqual(["fun", "sports"]);
    });
  });

  describe("findChat", () => {
    it("never returns a private (1:1) chat, even if the keyword matches its link", async () => {
      const a = new Types.ObjectId().toString();
      const b = new Types.ObjectId().toString();
      await ChatModel.create({
        link: `private-${a}-${b}`,
        type: ChatType.PRIVATE,
      });
      await ChatModel.create({
        link: "public-group",
        type: ChatType.GROUP,
        name: "Public Group",
        isPublic: true,
      });
      await ChatModel.create({
        link: "private-group",
        type: ChatType.GROUP,
        name: "Private Group",
      });

      const results = await service.findChat(a);
      expect(results).toHaveLength(0);

      const all = await service.findChat();
      expect(all.map(c => c.type)).toEqual([ChatType.GROUP]);
    });
  });
});
