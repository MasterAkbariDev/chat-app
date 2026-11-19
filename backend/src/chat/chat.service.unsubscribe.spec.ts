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

describe("ChatService.unsubscribe (owner-leave ownership transfer)", () => {
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
      MessageModel.deleteMany({}),
      UserModel.deleteMany({}),
    ]);
    jest.clearAllMocks();
  });

  async function createGroup(ownerId: string) {
    const chat = await ChatModel.create({
      link: `group-${Date.now()}-${Math.random()}`,
      type: ChatType.GROUP,
      name: "Test Group",
    });
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: ownerId,
      role: UserRole.OWNER,
    });
    return chat;
  }

  it("promotes the longest-tenured admin to owner when the owner leaves", async () => {
    const ownerId = new Types.ObjectId().toString();
    const olderAdminId = new Types.ObjectId().toString();
    const newerAdminId = new Types.ObjectId().toString();
    const chat = await createGroup(ownerId);

    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: olderAdminId,
      role: UserRole.ADMIN,
    });
    // Ensure a distinct createdAt ordering between the two admins.
    await new Promise(resolve => setTimeout(resolve, 5));
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: newerAdminId,
      role: UserRole.ADMIN,
    });

    const result = await service.unsubscribe(chat._id.toString(), ownerId);
    expect(result).toBe(true);

    const remainingOwner = await ChatMembersModel.findOne({
      channelId: chat._id.toString(),
      role: UserRole.OWNER,
    }).lean();
    expect(remainingOwner?.userId).toBe(olderAdminId);

    const leftMembership = await ChatMembersModel.findOne({
      channelId: chat._id.toString(),
      userId: ownerId,
    }).lean();
    expect(leftMembership).toBeNull();
  });

  it("falls back to the longest-tenured member when there is no admin", async () => {
    const ownerId = new Types.ObjectId().toString();
    const memberId = new Types.ObjectId().toString();
    const chat = await createGroup(ownerId);
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: memberId,
      role: UserRole.MEMBER,
    });

    await service.unsubscribe(chat._id.toString(), ownerId);

    const remainingOwner = await ChatMembersModel.findOne({
      channelId: chat._id.toString(),
      role: UserRole.OWNER,
    }).lean();
    expect(remainingOwner?.userId).toBe(memberId);
  });

  it("skips a banned member when picking a successor", async () => {
    const ownerId = new Types.ObjectId().toString();
    const bannedAdminId = new Types.ObjectId().toString();
    const memberId = new Types.ObjectId().toString();
    const chat = await createGroup(ownerId);
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: bannedAdminId,
      role: UserRole.ADMIN,
      isBanned: true,
    });
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: memberId,
      role: UserRole.MEMBER,
    });

    await service.unsubscribe(chat._id.toString(), ownerId);

    const remainingOwner = await ChatMembersModel.findOne({
      channelId: chat._id.toString(),
      role: UserRole.OWNER,
    }).lean();
    expect(remainingOwner?.userId).toBe(memberId);
  });

  it("leaves the channel ownerless when the owner is the sole member", async () => {
    const ownerId = new Types.ObjectId().toString();
    const chat = await createGroup(ownerId);

    const result = await service.unsubscribe(chat._id.toString(), ownerId);
    expect(result).toBe(true);

    const remaining = await ChatMembersModel.find({
      channelId: chat._id.toString(),
    }).lean();
    expect(remaining).toEqual([]);
  });

  it("propagates a real error instead of swallowing it into a 2xx `false`", async () => {
    const chat = await ChatModel.create({
      link: `group-${Date.now()}-${Math.random()}`,
      type: ChatType.GROUP,
      name: "Test Group",
    });
    const notJoinedUserId = new Types.ObjectId().toString();

    await expect(
      service.unsubscribe(chat._id.toString(), notJoinedUserId),
    ).rejects.toThrow(/not joined/i);
  });
});
