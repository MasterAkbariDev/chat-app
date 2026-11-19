import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Chat, ChatSchema } from "./schema/chat.schema";
import { ChatMembers, ChatMembersSchema } from "./schema/chat-members.schema";
import { ChatState, ChatStateSchema } from "./schema/chat-state.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { ChatStateListener } from "./chat-state.listener";
import type { ChatService } from "./chat.service";
import { ChannelsService } from "src/channels/channels.service";
import { ChatType, MessageType, UserRole } from "src/enum/base.enum";
import type { FoldersService } from "src/folders/folders.service";
import type { ChatGateway } from "src/gateway/chat.gateway";
import type { EventEmitter2 } from "eventemitter2";
import { privacyServiceFor } from "src/common/testing/privacy";

/**
 * Chat list preview after deletes (for everyone and for me) + pinned chat order — the
 * listener and the list aggregation together, against a real (in-memory) MongoDB.
 */
describe("Chat list preview after deletes, and pinned order", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatModel: Model<Chat>;
  let MembersModel: Model<ChatMembers>;
  let StateModel: Model<ChatState>;
  let MessageModel: Model<Message>;
  let UserModel: Model<User>;
  let listener: ChatStateListener;
  let channels: ChannelsService;
  let chats: ChatService;

  const me = new Types.ObjectId().toString();
  const other = new Types.ObjectId().toString();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ChatModel = connection.model(Chat.name, ChatSchema);
    MembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    StateModel = connection.model(ChatState.name, ChatStateSchema);
    MessageModel = connection.model(Message.name, MessageSchema);
    UserModel = connection.model(User.name, UserSchema);
    listener = new ChatStateListener(StateModel, MembersModel, MessageModel);
    channels = new ChannelsService(
      MembersModel,
      { getOwnedFolder: jest.fn() } as unknown as FoldersService,
      privacyServiceFor(connection),
    );
    // ChatService pulls in ChatGateway, which reads CORS_ORIGIN at import time.
    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";
    const { ChatService } = await import("./chat.service");
    chats = new ChatService(
      ChatModel,
      MembersModel,
      UserModel,
      MessageModel,
      {} as ChatGateway,
      { emit: jest.fn() } as unknown as EventEmitter2,
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
      MembersModel.deleteMany({}),
      StateModel.deleteMany({}),
      MessageModel.deleteMany({}),
    ]);
  });

  async function makeGroup(name = "Group") {
    const chat = await ChatModel.create({
      link: `g-${new Types.ObjectId().toString()}`,
      type: ChatType.GROUP,
      name,
    });
    const channelId = chat._id.toString();
    await MembersModel.create([
      { channelId, userId: me, role: UserRole.OWNER },
      { channelId, userId: other, role: UserRole.MEMBER },
    ]);
    return channelId;
  }

  async function send(channelId: string, content: string, at: string) {
    const msg = await MessageModel.create({
      channelId,
      senderId: new Types.ObjectId(other),
      content,
      type: MessageType.TEXT,
      createdAt: new Date(at),
    });
    await listener.onMessageCreated({
      channelId,
      createdAt: msg.createdAt,
      preview: content,
    });
    return msg;
  }

  async function rowFor(userId: string, channelId: string) {
    const { items } = await channels.listMine(userId);
    return items.find(i => i.channelId === channelId)!;
  }

  it("delete for everyone of the last message falls back to the previous one for all", async () => {
    const channelId = await makeGroup();
    await send(channelId, "first", "2024-01-01T00:00:00Z");
    const last = await send(channelId, "second", "2024-01-02T00:00:00Z");

    await MessageModel.updateOne({ _id: last._id }, { isDeleted: true });
    await listener.onMessageDeleted({ channelId });

    for (const user of [me, other]) {
      const row = await rowFor(user, channelId);
      expect(row.lastMessagePreview).toBe("first");
      expect(new Date(row.lastMessageAt!).toISOString()).toBe(
        "2024-01-01T00:00:00.000Z",
      );
    }
  });

  it("delete for me of the last message changes only my preview", async () => {
    const channelId = await makeGroup();
    await send(channelId, "first", "2024-01-01T00:00:00Z");
    const last = await send(channelId, "second", "2024-01-02T00:00:00Z");

    await MessageModel.updateOne(
      { _id: last._id },
      { $addToSet: { deletedFor: new Types.ObjectId(me) } },
    );
    await listener.onMessageDeletedForMe({ channelId, userId: me });

    const mine = await rowFor(me, channelId);
    expect(mine.lastMessagePreview).toBe("first");
    expect(new Date(mine.lastMessageAt!).toISOString()).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect((await rowFor(other, channelId)).lastMessagePreview).toBe("second");
  });

  it("delete for me of an older message keeps no per-member state", async () => {
    const channelId = await makeGroup();
    const first = await send(channelId, "first", "2024-01-01T00:00:00Z");
    await send(channelId, "second", "2024-01-02T00:00:00Z");

    await MessageModel.updateOne(
      { _id: first._id },
      { $addToSet: { deletedFor: new Types.ObjectId(me) } },
    );
    await listener.onMessageDeletedForMe({ channelId, userId: me });

    const membership = await MembersModel.findOne({ channelId, userId: me })
      .lean()
      .exec();
    expect(membership?.lastVisibleOverride ?? null).toBeNull();
    expect((await rowFor(me, channelId)).lastMessagePreview).toBe("second");
  });

  it("a newer message makes my delete-for-me override stale automatically", async () => {
    const channelId = await makeGroup();
    await send(channelId, "first", "2024-01-01T00:00:00Z");
    const last = await send(channelId, "second", "2024-01-02T00:00:00Z");
    await MessageModel.updateOne(
      { _id: last._id },
      { $addToSet: { deletedFor: new Types.ObjectId(me) } },
    );
    await listener.onMessageDeletedForMe({ channelId, userId: me });

    await send(channelId, "third", "2024-01-03T00:00:00Z");

    expect((await rowFor(me, channelId)).lastMessagePreview).toBe("third");
  });

  it("deleting all my visible messages for me leaves an empty preview", async () => {
    const channelId = await makeGroup();
    const only = await send(channelId, "only", "2024-01-01T00:00:00Z");
    await MessageModel.updateOne(
      { _id: only._id },
      { $addToSet: { deletedFor: new Types.ObjectId(me) } },
    );
    await listener.onMessageDeletedForMe({ channelId, userId: me });

    const row = await rowFor(me, channelId);
    expect(row.lastMessagePreview).toBeNull();
    expect(row.lastMessageAt).toBeNull();
    expect(row.unread).toBe(false);
  });

  it("delete for everyone skips a new last message I had already deleted for me", async () => {
    const channelId = await makeGroup();
    await send(channelId, "first", "2024-01-01T00:00:00Z");
    const middle = await send(channelId, "second", "2024-01-02T00:00:00Z");
    const last = await send(channelId, "third", "2024-01-03T00:00:00Z");
    // I hid "second" while it wasn't the latest — no override was needed then.
    await MessageModel.updateOne(
      { _id: middle._id },
      { $addToSet: { deletedFor: new Types.ObjectId(me) } },
    );
    await listener.onMessageDeletedForMe({ channelId, userId: me });

    await MessageModel.updateOne({ _id: last._id }, { isDeleted: true });
    await listener.onMessageDeleted({ channelId });

    expect((await rowFor(other, channelId)).lastMessagePreview).toBe("second");
    expect((await rowFor(me, channelId)).lastMessagePreview).toBe("first");
  });

  it("delete-for-me respects cleared history (hiddenAt)", async () => {
    const channelId = await makeGroup();
    await send(channelId, "before clear", "2024-01-01T00:00:00Z");
    await MembersModel.updateOne(
      { channelId, userId: me },
      { hiddenAt: new Date("2024-01-01T12:00:00Z") },
    );
    const last = await send(channelId, "after clear", "2024-01-02T00:00:00Z");
    await MessageModel.updateOne(
      { _id: last._id },
      { $addToSet: { deletedFor: new Types.ObjectId(me) } },
    );
    await listener.onMessageDeletedForMe({ channelId, userId: me });

    expect((await rowFor(me, channelId)).lastMessagePreview).toBeNull();
  });

  it("the list sorts by my own last visible message", async () => {
    const a = await makeGroup("A");
    const b = await makeGroup("B");
    await send(a, "a1", "2024-01-01T00:00:00Z");
    await send(b, "b1", "2024-01-02T00:00:00Z");
    const a2 = await send(a, "a2", "2024-01-03T00:00:00Z");

    await MessageModel.updateOne(
      { _id: a2._id },
      { $addToSet: { deletedFor: new Types.ObjectId(me) } },
    );
    await listener.onMessageDeletedForMe({ channelId: a, userId: me });

    const { items } = await channels.listMine(me);
    expect(items.map(i => i.channelId)).toEqual([b, a]);
  });

  describe("pinned order", () => {
    it("a newly pinned chat goes to the top; reorderPins sets an explicit order", async () => {
      const a = await makeGroup("A");
      const b = await makeGroup("B");
      const c = await makeGroup("C");
      await send(a, "a", "2024-01-03T00:00:00Z");
      await send(b, "b", "2024-01-02T00:00:00Z");
      await send(c, "c", "2024-01-01T00:00:00Z");

      await chats.setPinned(a, me, true);
      await chats.setPinned(c, me, true);
      let { items } = await channels.listMine(me);
      expect(items.map(i => i.channelId)).toEqual([c, a, b]);

      await channels.reorderPins(me, [a, c]);
      ({ items } = await channels.listMine(me));
      expect(items.map(i => i.channelId)).toEqual([a, c, b]);

      // Unpinning clears the position; ids that aren't pinned are ignored.
      await chats.setPinned(a, me, false);
      await channels.reorderPins(me, [b, c]);
      ({ items } = await channels.listMine(me));
      expect(items.map(i => [i.channelId, i.isPinned])).toEqual([
        [c, true],
        [a, false],
        [b, false],
      ]);
      const unpinned = await MembersModel.findOne({ channelId: a, userId: me })
        .lean()
        .exec();
      expect(unpinned?.pinOrder ?? null).toBeNull();
    });

    it("chats pinned before ordering existed sort after ordered ones, by recency", async () => {
      const legacyOld = await makeGroup("old");
      const legacyNew = await makeGroup("new");
      const ordered = await makeGroup("ordered");
      await send(legacyOld, "x", "2024-01-01T00:00:00Z");
      await send(legacyNew, "y", "2024-01-05T00:00:00Z");
      await send(ordered, "z", "2024-01-02T00:00:00Z");
      await MembersModel.updateMany(
        { userId: me, channelId: { $in: [legacyOld, legacyNew] } },
        { isPinned: true },
      );
      await chats.setPinned(ordered, me, true);

      const { items } = await channels.listMine(me);
      expect(items.map(i => i.channelId)).toEqual([
        ordered,
        legacyNew,
        legacyOld,
      ]);
    });

    it("reorderPins only touches the caller's rows", async () => {
      const a = await makeGroup("A");
      await chats.setPinned(a, other, true);
      await channels.reorderPins(me, [a]);
      const mine = await MembersModel.findOne({ channelId: a, userId: me })
        .lean()
        .exec();
      expect(mine?.pinOrder ?? null).toBeNull();
      expect(mine?.isPinned).toBe(false);
    });
  });
});
