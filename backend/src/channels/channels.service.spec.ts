import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { ChatState, ChatStateSchema } from "src/chat/schema/chat-state.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { ChannelsService } from "./channels.service";
import { ChatType, UserRole } from "src/enum/base.enum";
import type { FoldersService } from "src/folders/folders.service";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("ChannelsService.listMine (B2: one-aggregation channel list)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatModel: Model<Chat>;
  let ChatMembersModel: Model<ChatMembers>;
  let ChatStateModel: Model<ChatState>;
  let UserModel: Model<User>;
  let service: ChannelsService;
  let fakeFoldersService: FoldersService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ChatModel = connection.model(Chat.name, ChatSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    ChatStateModel = connection.model(ChatState.name, ChatStateSchema);
    UserModel = connection.model(User.name, UserSchema);

    fakeFoldersService = {
      getOwnedFolder: jest.fn(),
    } as unknown as FoldersService;
    service = new ChannelsService(
      ChatMembersModel,
      fakeFoldersService,
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
      ChatStateModel.deleteMany({}),
      UserModel.deleteMany({}),
    ]);
  });

  async function makeGroup(
    userId: string,
    opts: {
      lastMessageAt?: Date;
      memberCount?: number;
      isPinned?: boolean;
    } = {},
  ) {
    const chat = await ChatModel.create({
      link: `g-${new Types.ObjectId().toString()}`,
      type: ChatType.GROUP,
      name: "Group " + Math.random().toString(36).slice(2, 6),
    });
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId,
      role: UserRole.MEMBER,
      isPinned: opts.isPinned ?? false,
    });
    await ChatStateModel.create({
      channelId: chat._id.toString(),
      lastMessageAt: opts.lastMessageAt ?? new Date(),
      lastMessagePreview: "hello",
      memberCount: opts.memberCount ?? 1,
    });
    return chat;
  }

  it("returns a group chat with its chat_state (memberCount, lastMessagePreview) and myRole", async () => {
    const userId = new Types.ObjectId().toString();
    const lastMessageAt = new Date("2024-01-01T00:00:00.000Z");
    const chat = await makeGroup(userId, { lastMessageAt, memberCount: 7 });

    const { items } = await service.listMine(userId);

    expect(items).toHaveLength(1);
    expect(items[0].channelId).toBe(chat._id.toString());
    expect(items[0].type).toBe(ChatType.GROUP);
    expect(items[0].myRole).toBe(UserRole.MEMBER);
    expect(items[0].memberCount).toBe(7);
    expect(items[0].lastMessagePreview).toBe("hello");
    expect(items[0].lastMessageAt?.toISOString()).toBe(
      lastMessageAt.toISOString(),
    );
    expect(items[0].otherUser).toBeUndefined();
  });

  it("private chats resolve the other member's public profile via one aggregation", async () => {
    const meId = new Types.ObjectId().toString();
    const otherUser = await UserModel.create({
      username: "bob",
      email: "bob@example.com",
      password: "hashed",
      firstName: "Bob",
      lastName: "Builder",
      image: ["https://example.com/bob.jpg"],
    });
    const chat = await ChatModel.create({
      link: `private-${meId}`,
      type: ChatType.PRIVATE,
      name: "Private",
    });
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: meId,
      role: UserRole.MEMBER,
    });
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: otherUser._id.toString(),
      role: UserRole.MEMBER,
    });
    await ChatStateModel.create({
      channelId: chat._id.toString(),
      lastMessageAt: new Date(),
      lastMessagePreview: "hi",
      memberCount: 2,
    });

    const { items } = await service.listMine(meId);

    expect(items).toHaveLength(1);
    expect(items[0].type).toBe(ChatType.PRIVATE);
    expect(items[0].memberCount).toBeUndefined();
    expect(items[0].otherUser).toBeDefined();
    expect(items[0].otherUser?.username).toBe("bob");
    // The recurring avatarUrl/image field-name bug, fixed at this boundary too.
    expect(items[0].otherUser?.avatarUrl).toEqual([
      "https://example.com/bob.jpg",
    ]);
    expect(items[0].otherUser).not.toHaveProperty("email");
  });

  it("resolves the other DM member correctly for both participants, never the caller's own account", async () => {
    // Regression test: a report against this exact endpoint found otherUser._id
    // equal to the *caller's* own id instead of the actual other participant.
    // Reproduced directly against a real MongoDB with this data shape (two
    // ChatMembers rows, one per participant, no duplicates) and could not
    // reproduce the bug there either — this test locks in the correct,
    // verified behavior in both directions so a future regression is caught.
    const me = await UserModel.create({
      username: "alice",
      email: "alice@example.com",
      password: "hashed",
    });
    const other = await UserModel.create({
      username: "bob",
      email: "bob@example.com",
      password: "hashed",
    });
    const chat = await ChatModel.create({
      link: `private-${me._id.toString()}-${other._id.toString()}`,
      type: ChatType.PRIVATE,
      name: "Private",
    });
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: me._id.toString(),
      role: UserRole.OWNER,
    });
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: other._id.toString(),
      role: UserRole.MEMBER,
    });
    await ChatStateModel.create({
      channelId: chat._id.toString(),
      lastMessageAt: new Date(),
      lastMessagePreview: "hi",
      memberCount: 2,
    });

    const asMe = await service.listMine(me._id.toString());
    expect(asMe.items[0].otherUser?._id).toBe(other._id.toString());
    expect(asMe.items[0].otherUser?._id).not.toBe(me._id.toString());

    const asOther = await service.listMine(other._id.toString());
    expect(asOther.items[0].otherUser?._id).toBe(me._id.toString());
    expect(asOther.items[0].otherUser?._id).not.toBe(other._id.toString());
  });

  it("pinned chats are always included, ahead of non-pinned ones regardless of recency", async () => {
    const userId = new Types.ObjectId().toString();
    const recent = await makeGroup(userId, {
      lastMessageAt: new Date("2024-06-01T00:00:00.000Z"),
    });
    const pinnedButOld = await makeGroup(userId, {
      lastMessageAt: new Date("2020-01-01T00:00:00.000Z"),
      isPinned: true,
    });

    const { items } = await service.listMine(userId);

    expect(items.map(i => i.channelId)).toEqual([
      pinnedButOld._id.toString(),
      recent._id.toString(),
    ]);
    expect(items[0].isPinned).toBe(true);
  });

  it("excludes chats the user left or was banned from", async () => {
    const userId = new Types.ObjectId().toString();
    const active = await makeGroup(userId);

    const leftChat = await ChatModel.create({
      link: `left-${userId}`,
      type: ChatType.GROUP,
      name: "Left group",
    });
    await ChatMembersModel.create({
      channelId: leftChat._id.toString(),
      userId,
      role: UserRole.MEMBER,
      isJoined: false,
    });

    const bannedChat = await ChatModel.create({
      link: `banned-${userId}`,
      type: ChatType.GROUP,
      name: "Banned group",
    });
    await ChatMembersModel.create({
      channelId: bannedChat._id.toString(),
      userId,
      role: UserRole.MEMBER,
      isBanned: true,
    });

    const { items } = await service.listMine(userId);

    expect(items.map(i => i.channelId)).toEqual([active._id.toString()]);
  });

  it("keyset-paginates non-pinned chats by lastMessageAt, oldest to newest across pages", async () => {
    const userId = new Types.ObjectId().toString();
    const times = [5, 4, 3, 2, 1].map(
      daysAgo => new Date(Date.now() - daysAgo * 86_400_000),
    );
    const chats: Array<Awaited<ReturnType<typeof makeGroup>>> = [];
    for (const t of times) {
      chats.push(await makeGroup(userId, { lastMessageAt: t }));
    }
    // `times` is oldest-first; the newest message should come back first.
    const expectedOrder = [...chats].reverse().map(c => c._id.toString());

    const page1 = await service.listMine(userId, { limit: 2 });
    expect(page1.items.map(i => i.channelId)).toEqual(
      expectedOrder.slice(0, 2),
    );
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await service.listMine(userId, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map(i => i.channelId)).toEqual(
      expectedOrder.slice(2, 4),
    );
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await service.listMine(userId, {
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.items.map(i => i.channelId)).toEqual(
      expectedOrder.slice(4, 5),
    );
    expect(page3.nextCursor).toBeNull();
  });

  describe("folder filtering (B6: applied inside the same aggregation)", () => {
    function mockFolder(filters: Partial<Record<string, unknown>>) {
      (fakeFoldersService.getOwnedFolder as jest.Mock).mockResolvedValue({
        _id: "folder1",
        ownerId: "owner",
        name: "Test folder",
        order: 0,
        filters: {
          includeTypes: [],
          includeTags: [],
          includeChannelIds: [],
          excludeChannelIds: [],
          onlyUnread: false,
          ...filters,
        },
      });
    }

    it("includeTypes narrows to only the given chat types", async () => {
      const userId = new Types.ObjectId().toString();
      const group = await makeGroup(userId);
      const privateChat = await ChatModel.create({
        link: `private-${userId}-x`,
        type: ChatType.PRIVATE,
      });
      await ChatMembersModel.create({
        channelId: privateChat._id.toString(),
        userId,
        role: UserRole.MEMBER,
      });
      await ChatStateModel.create({
        channelId: privateChat._id.toString(),
        lastMessageAt: new Date(),
      });

      mockFolder({ includeTypes: [ChatType.GROUP] });
      const { items } = await service.listMine(userId, { folderId: "folder1" });

      expect(items.map(i => i.channelId)).toEqual([group._id.toString()]);
    });

    it("includeChannelIds/excludeChannelIds narrow the result set", async () => {
      const userId = new Types.ObjectId().toString();
      const included = await makeGroup(userId);
      const excluded = await makeGroup(userId);

      mockFolder({ includeChannelIds: [included._id.toString()] });
      const { items } = await service.listMine(userId, { folderId: "folder1" });
      expect(items.map(i => i.channelId)).toEqual([included._id.toString()]);

      mockFolder({ excludeChannelIds: [excluded._id.toString()] });
      const { items: items2 } = await service.listMine(userId, {
        folderId: "folder1",
      });
      expect(items2.map(i => i.channelId).sort()).toEqual(
        [included._id.toString()].sort(),
      );
    });

    it("onlyUnread keeps chats with unread messages and drops fully-read ones", async () => {
      const userId = new Types.ObjectId().toString();
      const unread = await makeGroup(userId, {
        lastMessageAt: new Date("2024-06-01T00:00:00.000Z"),
      });
      const read = await makeGroup(userId, {
        lastMessageAt: new Date("2024-06-01T00:00:00.000Z"),
      });
      await ChatMembersModel.updateOne(
        { channelId: read._id.toString(), userId },
        { $set: { lastReadAt: new Date("2024-06-02T00:00:00.000Z") } },
      );

      mockFolder({ onlyUnread: true });
      const { items } = await service.listMine(userId, { folderId: "folder1" });

      expect(items.map(i => i.channelId)).toEqual([unread._id.toString()]);
    });
  });
  it("clear history: no preview or unread up to hiddenAt, chat keeps its place; a newer message shows again", async () => {
    const userId = new Types.ObjectId().toString();
    const older = await makeGroup(userId, {
      lastMessageAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    const cleared = await makeGroup(userId, {
      lastMessageAt: new Date("2024-02-01T00:00:00.000Z"),
    });
    await ChatMembersModel.updateOne(
      { channelId: cleared._id.toString(), userId },
      { $set: { hiddenAt: new Date("2024-03-01T00:00:00.000Z") } },
    );

    let { items } = await service.listMine(userId);
    expect(items.map(i => i.channelId)).toEqual([
      cleared._id.toString(),
      older._id.toString(),
    ]);
    expect(items[0]).toMatchObject({
      historyCleared: true,
      lastMessagePreview: null,
      unread: false,
    });
    expect(items[1]).toMatchObject({
      historyCleared: false,
      lastMessagePreview: "hello",
      unread: true,
    });

    // A message after the clear is a normal preview (and unread) again.
    await ChatStateModel.updateOne(
      { channelId: cleared._id.toString() },
      { $set: { lastMessageAt: new Date("2024-04-01T00:00:00.000Z") } },
    );
    ({ items } = await service.listMine(userId));
    expect(items[0]).toMatchObject({
      historyCleared: false,
      lastMessagePreview: "hello",
      unread: true,
    });
  });
});
