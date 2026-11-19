import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Chat, ChatSchema } from "./schema/chat.schema";
import { ChatMembers, ChatMembersSchema } from "./schema/chat-members.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import type { ChatGateway } from "src/gateway/chat.gateway";
import type { ChatService as ChatServiceType } from "./chat.service";
import type { EventEmitter2 } from "eventemitter2";
import { ChatType } from "src/enum/base.enum";
import { privacyServiceFor } from "src/common/testing/privacy";

/** Joins are announced in groups only. A channel's subscribers never get a join row, so no
 *  client can receive one (not even from a refetch or a socket resync). */
describe("ChatService.subscribe — join notices", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatModel: Model<Chat>;
  let ChatMembersModel: Model<ChatMembers>;
  let UserModel: Model<User>;
  let MessageModel: Model<Message>;
  let service: ChatServiceType;

  const fakeGateway = {
    notifyNewChat: jest.fn().mockResolvedValue(undefined),
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

  async function makeChat(type: ChatType) {
    const chat = await ChatModel.create({
      link: `c-${Date.now()}-${Math.random()}`,
      type,
      name: "Room",
      isPublic: true,
    });
    return chat._id.toString();
  }

  it("writes no join row when someone subscribes to a channel", async () => {
    const channelId = await makeChat(ChatType.CHANNEL);
    const userId = new Types.ObjectId().toString();
    await UserModel.create({
      _id: userId,
      username: "joiner",
      firstName: "Jo",
      password: "x",
    });

    await service.subscribe(channelId, userId);

    expect(await ChatMembersModel.countDocuments({ channelId, userId })).toBe(
      1,
    );
    expect(await MessageModel.countDocuments({ channelId })).toBe(0);
  });

  it("still announces the join in a group", async () => {
    const channelId = await makeChat(ChatType.GROUP);
    const userId = new Types.ObjectId().toString();
    await UserModel.create({
      _id: userId,
      username: "joiner",
      firstName: "Jo",
      password: "x",
    });

    await service.subscribe(channelId, userId);

    const rows = await MessageModel.find({ channelId }).lean().exec();
    expect(rows.map(r => r.content)).toEqual(["member_joined"]);
  });
});
