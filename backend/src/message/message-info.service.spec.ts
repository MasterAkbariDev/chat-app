import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Message, MessageSchema } from "./schema/message.schema";
import {
  MessageReaction,
  MessageReactionSchema,
} from "./schema/message-reaction.schema";
import {
  ReadCheckpoint,
  ReadCheckpointSchema,
} from "./schema/read-checkpoint.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Block, BlockSchema } from "src/user/schema/block.schema";
import { ChatType, UserRole } from "src/enum/base.enum";
import { MessageInfoService } from "./message-info.service";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("MessageInfoService (Telegram-style seen-by + reactions list)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MessageModel: Model<Message>;
  let ReactionModel: Model<MessageReaction>;
  let CheckpointModel: Model<ReadCheckpoint>;
  let MembersModel: Model<ChatMembers>;
  let ChatModel: Model<Chat>;
  let UserModel: Model<User>;
  let BlockModel: Model<Block>;
  let service: MessageInfoService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    MessageModel = connection.model(Message.name, MessageSchema);
    ReactionModel = connection.model(
      MessageReaction.name,
      MessageReactionSchema,
    );
    CheckpointModel = connection.model(
      ReadCheckpoint.name,
      ReadCheckpointSchema,
    );
    MembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    UserModel = connection.model(User.name, UserSchema);
    BlockModel = connection.model(Block.name, BlockSchema);
    service = new MessageInfoService(
      MessageModel,
      ReactionModel,
      CheckpointModel,
      MembersModel,
      ChatModel,
      UserModel,
      BlockModel,
      privacyServiceFor(connection),
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all(
      [
        MessageModel,
        ReactionModel,
        CheckpointModel,
        MembersModel,
        ChatModel,
        UserModel,
        BlockModel,
      ].map(m => (m as Model<unknown>).deleteMany({})),
    );
  });

  async function makeUser(name: string) {
    const u = await UserModel.create({
      username: name,
      firstName: name,
      email: `${name}-${Math.random()}@example.com`,
      password: "hashed",
    });
    return u._id.toString();
  }

  async function makeChat(type: ChatType, members: string[], roles = {}) {
    const chat = await ChatModel.create({
      link: `t-${Date.now()}-${Math.random()}`,
      name: "Chat",
      type,
    });
    const channelId = chat._id.toString();
    await MembersModel.insertMany(
      members.map(userId => ({
        channelId,
        userId,
        role: (roles as Record<string, UserRole>)[userId] ?? UserRole.MEMBER,
      })),
    );
    return channelId;
  }

  async function send(channelId: string, senderId: string, at: Date) {
    const m = await MessageModel.create({
      channelId,
      senderId: new Types.ObjectId(senderId),
      content: "hi",
      createdAt: at,
    });
    return m;
  }

  /** What MessageService.markAsRead does: move the pointer + emit the event. */
  async function read(
    channelId: string,
    userId: string,
    msg: { _id: Types.ObjectId; createdAt: Date },
    readAt: Date,
  ) {
    await MembersModel.updateOne(
      { channelId, userId },
      { $set: { lastReadMessageId: msg._id.toString(), lastReadAt: readAt } },
    );
    await service.recordRead({
      channelId,
      userId,
      upToCreatedAt: msg.createdAt,
      readAt,
    });
  }

  const now = Date.now();
  const t = (minAgo: number) => new Date(now - minAgo * 60_000);

  it("lists readers with the time each first read the message, newest first", async () => {
    const [maya, omid, sara, kian] = await Promise.all(
      ["maya", "omid", "sara", "kian"].map(makeUser),
    );
    const channelId = await makeChat(ChatType.GROUP, [maya, omid, sara, kian]);
    const m1 = await send(channelId, maya, t(60));
    const m2 = await send(channelId, omid, t(50));

    await read(channelId, omid, m1, t(55)); // omid reads m1 at -55
    await read(channelId, sara, m1, t(40)); // sara reads m1 at -40
    await read(channelId, sara, m2, t(30)); // later read must not move m1's time
    await read(channelId, omid, m2, t(20));

    const info = await service.getReadInfo(m1._id.toString(), maya);
    expect(info.readers.map(r => r.user.username)).toEqual(["sara", "omid"]);
    expect(info.readers[0].readAt?.getTime()).toBe(t(40).getTime());
    expect(info.readers[1].readAt?.getTime()).toBe(t(55).getTime());
    expect(info.total).toBe(2);
    expect(info.eligible).toBe(3);
    expect(info.kept).toBe(true);
    expect(info.hidden).toBe(false);
    expect(info.readBy).toHaveLength(2);
  });

  it("does not record a checkpoint when the read covers nothing new", async () => {
    const [maya, omid] = await Promise.all(["maya", "omid"].map(makeUser));
    const channelId = await makeChat(ChatType.PRIVATE, [maya, omid]);
    const m1 = await send(channelId, maya, t(10));
    await read(channelId, omid, m1, t(9));
    await read(channelId, omid, m1, t(5));
    expect(await CheckpointModel.countDocuments({ userId: omid })).toBe(1);
    const info = await service.getReadInfo(m1._id.toString(), maya);
    expect(info.readers[0].readAt?.getTime()).toBe(t(9).getTime());
  });

  it("falls back to 'seen' without a time when only the read pointer covers it", async () => {
    const [maya, omid] = await Promise.all(["maya", "omid"].map(makeUser));
    const channelId = await makeChat(ChatType.PRIVATE, [maya, omid]);
    const old = await send(channelId, maya, t(60 * 24 * 10)); // 10 days ago
    const later = await send(channelId, omid, t(60 * 24 * 9));
    await MembersModel.updateOne(
      { channelId, userId: omid },
      { $set: { lastReadMessageId: later._id.toString() } },
    );
    const info = await service.getReadInfo(old._id.toString(), maya);
    expect(info.kept).toBe(false);
    expect(info.readers).toHaveLength(1);
    expect(info.readers[0].readAt).toBeNull();
  });

  it("is author-only, empty for channels, and skips readers who blocked the author", async () => {
    const [maya, omid, sara] = await Promise.all(
      ["maya", "omid", "sara"].map(makeUser),
    );
    const group = await makeChat(ChatType.GROUP, [maya, omid, sara]);
    const m = await send(group, maya, t(5));
    await read(group, omid, m, t(4));
    await read(group, sara, m, t(3));
    await BlockModel.create({
      blockerId: new Types.ObjectId(sara),
      blockedId: new Types.ObjectId(maya),
    });
    await expect(service.getReadInfo(m._id.toString(), omid)).rejects.toThrow(
      /only the message author/i,
    );
    const info = await service.getReadInfo(m._id.toString(), maya);
    expect(info.readers.map(r => r.user.username)).toEqual(["omid"]);

    const channel = await makeChat(ChatType.CHANNEL, [maya, omid]);
    const cm = await send(channel, maya, t(5));
    await read(channel, omid, cm, t(4));
    const cinfo = await service.getReadInfo(cm._id.toString(), maya);
    expect(cinfo.readers).toEqual([]);
    expect(cinfo.total).toBe(0);
  });

  it("hides the list (count only) in groups over 100 members", async () => {
    const maya = await makeUser("maya");
    const others = Array.from({ length: 100 }, () =>
      new Types.ObjectId().toString(),
    );
    const channelId = await makeChat(ChatType.GROUP, [maya, ...others]);
    const m = await send(channelId, maya, t(5));
    await read(channelId, others[0], m, t(4));
    const info = await service.getReadInfo(m._id.toString(), maya);
    expect(info.hidden).toBe(true);
    expect(info.total).toBe(1);
    expect(info.readers).toEqual([]);
  });

  describe("getReactionList", () => {
    it("lists reactors newest first for any member", async () => {
      const [maya, omid, sara] = await Promise.all(
        ["maya", "omid", "sara"].map(makeUser),
      );
      const channelId = await makeChat(ChatType.GROUP, [maya, omid, sara]);
      const m = await send(channelId, maya, t(5));
      await ReactionModel.create({
        messageId: m._id.toString(),
        channelId,
        userId: omid,
        emoji: "👍",
        createdAt: t(4),
      });
      await ReactionModel.create({
        messageId: m._id.toString(),
        channelId,
        userId: sara,
        packItemId: "item1",
        packItemRelativePath: "packs/x.webp",
        packId: "pack1",
        createdAt: t(3),
      });
      const res = await service.getReactionList(m._id.toString(), omid);
      expect(res.total).toBe(2);
      expect(res.reactions.map(r => r.user.username)).toEqual(["sara", "omid"]);
      expect(res.reactions[0]).toMatchObject({
        emoji: null,
        packItemId: "item1",
        relativePath: "packs/x.webp",
      });
      expect(res.reactions[1].emoji).toBe("👍");
    });

    it("rejects non-members and plain channel subscribers", async () => {
      const [maya, omid, outsider] = await Promise.all(
        ["maya", "omid", "out"].map(makeUser),
      );
      const channel = await makeChat(ChatType.CHANNEL, [maya, omid], {
        [maya]: UserRole.OWNER,
      });
      const m = await send(channel, maya, t(5));
      await expect(
        service.getReactionList(m._id.toString(), outsider),
      ).rejects.toThrow(/access denied/i);
      await expect(
        service.getReactionList(m._id.toString(), omid),
      ).rejects.toThrow(/only admins/i);
      await expect(
        service.getReactionList(m._id.toString(), maya),
      ).resolves.toMatchObject({ total: 0 });
    });
  });
  describe("getReadState (✓✓ for every own message up to the furthest reader)", () => {
    it("DM: the other person's read pointer, not the caller's own", async () => {
      const [maya, omid] = await Promise.all(["maya", "omid"].map(makeUser));
      const channelId = await makeChat(ChatType.PRIVATE, [maya, omid]);
      const m1 = await send(channelId, maya, t(30));
      const m2 = await send(channelId, maya, t(20));
      await send(channelId, maya, t(10));

      expect(
        (await service.getReadState(channelId, maya)).othersReadUpTo,
      ).toBeNull();
      await read(channelId, maya, m2, t(5)); // own read doesn't count
      expect(
        (await service.getReadState(channelId, maya)).othersReadUpTo,
      ).toBeNull();
      await read(channelId, omid, m1, t(4));
      expect((await service.getReadState(channelId, maya)).othersReadUpTo).toBe(
        m1.createdAt.toISOString(),
      );
    });

    it("group: the furthest of any other member; blockers excluded", async () => {
      const [maya, omid, sara] = await Promise.all(
        ["maya", "omid", "sara"].map(makeUser),
      );
      const channelId = await makeChat(ChatType.GROUP, [maya, omid, sara]);
      const m1 = await send(channelId, maya, t(30));
      const m2 = await send(channelId, maya, t(20));
      await read(channelId, omid, m1, t(5));
      await read(channelId, sara, m2, t(6)); // read earlier, but further
      expect((await service.getReadState(channelId, maya)).othersReadUpTo).toBe(
        m2.createdAt.toISOString(),
      );
      await BlockModel.create({
        blockerId: new Types.ObjectId(sara),
        blockedId: new Types.ObjectId(maya),
      });
      expect((await service.getReadState(channelId, maya)).othersReadUpTo).toBe(
        m1.createdAt.toISOString(),
      );
    });

    it("channels never expose reads; non-members are refused", async () => {
      const [maya, omid, kian] = await Promise.all(
        ["maya", "omid", "kian"].map(makeUser),
      );
      const channelId = await makeChat(ChatType.CHANNEL, [maya, omid], {
        [maya]: UserRole.OWNER,
      });
      const m1 = await send(channelId, maya, t(10));
      await read(channelId, omid, m1, t(5));
      const state = await service.getReadState(channelId, maya);
      expect(state).toEqual({
        chatType: ChatType.CHANNEL,
        othersReadUpTo: null,
      });
      await expect(service.getReadState(channelId, kian)).rejects.toThrow(
        "Access denied",
      );
    });
  });
});
