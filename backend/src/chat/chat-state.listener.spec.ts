import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { ChatState, ChatStateSchema } from "./schema/chat-state.schema";
import { ChatMembers, ChatMembersSchema } from "./schema/chat-members.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import { ChatStateListener } from "./chat-state.listener";
import { MessageType, UserRole } from "src/enum/base.enum";

describe("ChatStateListener (B2: chat_state kept in sync with domain events)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatStateModel: Model<ChatState>;
  let ChatMembersModel: Model<ChatMembers>;
  let MessageModel: Model<Message>;
  let listener: ChatStateListener;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ChatStateModel = connection.model(ChatState.name, ChatStateSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    MessageModel = connection.model(Message.name, MessageSchema);

    listener = new ChatStateListener(
      ChatStateModel,
      ChatMembersModel,
      MessageModel,
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all([
      ChatStateModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
      MessageModel.deleteMany({}),
    ]);
  });

  it("message.created upserts chat_state even when no row existed yet", async () => {
    const channelId = new Types.ObjectId().toString();
    const createdAt = new Date("2024-03-01T12:00:00.000Z");

    await listener.onMessageCreated({
      channelId,
      createdAt,
      preview: "hi there",
    });

    const state = await ChatStateModel.findOne({ channelId }).lean();
    expect(state?.lastMessagePreview).toBe("hi there");
    expect(state?.lastMessageAt?.toISOString()).toBe(createdAt.toISOString());
  });

  it("message.created overwrites a stale preview with the newer one", async () => {
    const channelId = new Types.ObjectId().toString();
    await listener.onMessageCreated({
      channelId,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      preview: "old",
    });
    await listener.onMessageCreated({
      channelId,
      createdAt: new Date("2024-02-01T00:00:00.000Z"),
      preview: "new",
    });

    const state = await ChatStateModel.findOne({ channelId }).lean();
    expect(state?.lastMessagePreview).toBe("new");
  });

  it("message.deleted recomputes lastMessage from the remaining, non-deleted messages", async () => {
    const channelId = new Types.ObjectId().toString();
    const senderId = new Types.ObjectId();
    const older = await MessageModel.create({
      channelId,
      senderId,
      content: "first",
      type: MessageType.TEXT,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    await MessageModel.create({
      channelId,
      senderId,
      content: "second (about to be deleted)",
      type: MessageType.TEXT,
      createdAt: new Date("2024-01-02T00:00:00.000Z"),
      isDeleted: true, // simulates the delete having already flipped the flag
    });
    await ChatStateModel.create({
      channelId,
      lastMessageAt: new Date("2024-01-02T00:00:00.000Z"),
      lastMessagePreview: "second (about to be deleted)",
      memberCount: 1,
    });

    await listener.onMessageDeleted({ channelId });

    const state = await ChatStateModel.findOne({ channelId }).lean();
    expect(state?.lastMessagePreview).toBe("first");
    expect(state?.lastMessageAt?.toISOString()).toBe(
      older.createdAt.toISOString(),
    );
  });

  it("message.deleted clears lastMessage when no messages remain", async () => {
    const channelId = new Types.ObjectId().toString();
    await ChatStateModel.create({
      channelId,
      lastMessageAt: new Date(),
      lastMessagePreview: "only message",
      memberCount: 1,
    });

    await listener.onMessageDeleted({ channelId });

    const state = await ChatStateModel.findOne({ channelId }).lean();
    expect(state?.lastMessagePreview).toBeNull();
    expect(state?.lastMessageAt).toBeNull();
  });

  it("membership.changed recomputes memberCount from active (joined, not banned) rows only", async () => {
    const channelId = new Types.ObjectId().toString();
    await ChatMembersModel.create([
      { channelId, userId: "u1", role: UserRole.OWNER, isJoined: true },
      { channelId, userId: "u2", role: UserRole.MEMBER, isJoined: true },
      { channelId, userId: "u3", role: UserRole.MEMBER, isJoined: false },
      {
        channelId,
        userId: "u4",
        role: UserRole.MEMBER,
        isJoined: true,
        isBanned: true,
      },
    ]);

    await listener.onMembershipChanged({ channelId });

    const state = await ChatStateModel.findOne({ channelId }).lean();
    expect(state?.memberCount).toBe(2);
  });
});
