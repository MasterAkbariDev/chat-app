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

describe("ChatService (B2: add members, ban migration)", () => {
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

    // ChatService transitively imports ChatGateway, whose @WebSocketGateway decorator reads
    // CORS_ORIGIN at module-load time — set it before the (dynamic) first import.
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
      link: `group-${Date.now()}`,
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

  it("addMembers actually adds members to the group (not a DM)", async () => {
    const ownerId = new Types.ObjectId().toString();
    const newMemberId = new Types.ObjectId().toString();
    const chat = await createGroup(ownerId);

    const result = await service.addMembers(
      chat._id.toString(),
      [newMemberId],
      ownerId,
    );

    expect(result.added).toEqual([newMemberId]);
    expect(result.skipped).toEqual([]);

    const membership = await ChatMembersModel.findOne({
      channelId: chat._id.toString(),
      userId: newMemberId,
    }).lean();
    expect(membership?.role).toBe(UserRole.MEMBER);
    expect(membership?.isJoined).toBe(true);
  });

  it("addMembers rejects a member when the group doesn't allow members to add people", async () => {
    const ownerId = new Types.ObjectId().toString();
    const memberId = new Types.ObjectId().toString();
    const targetId = new Types.ObjectId().toString();
    const chat = await createGroup(ownerId);
    await ChatModel.updateOne(
      { _id: chat._id },
      { $set: { defaultPermissions: { addMembers: false } } },
    );
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: memberId,
      role: UserRole.MEMBER,
    });

    await expect(
      service.addMembers(chat._id.toString(), [targetId], memberId),
    ).rejects.toThrow(/can't add members/i);
  });

  it("addMembers skips a banned user instead of re-adding them", async () => {
    const ownerId = new Types.ObjectId().toString();
    const bannedId = new Types.ObjectId().toString();
    const chat = await createGroup(ownerId);
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: bannedId,
      role: UserRole.MEMBER,
      isBanned: true,
      isJoined: false,
    });

    const result = await service.addMembers(
      chat._id.toString(),
      [bannedId],
      ownerId,
    );

    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual([bannedId]);
  });

  it("setBanned keeps the membership row (isBanned: true) instead of deleting it", async () => {
    const ownerId = new Types.ObjectId().toString();
    const targetUser = await UserModel.create({
      username: `target-${Date.now()}`,
      email: `target-${Date.now()}@example.com`,
      password: "hashed",
    });
    const targetId = targetUser._id.toString();
    const chat = await createGroup(ownerId);
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: targetId,
      role: UserRole.MEMBER,
    });

    await service.setBanned(chat._id.toString(), targetId, ownerId, true);

    const membership = await ChatMembersModel.findOne({
      channelId: chat._id.toString(),
      userId: targetId,
    }).lean();
    expect(membership).not.toBeNull();
    expect(membership?.isBanned).toBe(true);
    expect(membership?.isJoined).toBe(false);

    const { users } = await service.getBannedList(chat._id.toString(), ownerId);
    expect(users.map(u => u._id)).toEqual([targetId]);
  });
});
