import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Block, BlockSchema } from "src/user/schema/block.schema";
import { Contact, ContactSchema } from "src/contacts/schema/contact.schema";
import { ChatType, UserRole } from "src/enum/base.enum";
import { SearchScope } from "./search-scope.enum";
import type { SearchService as SearchServiceType } from "./search.service";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("SearchService (B6: unified people/channels/messages search)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let ChatModel: Model<Chat>;
  let MessageModel: Model<Message>;
  let ChatMembersModel: Model<ChatMembers>;
  let BlockModel: Model<Block>;
  let ContactModel: Model<Contact>;
  let service: SearchServiceType;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    MessageModel = connection.model(Message.name, MessageSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    BlockModel = connection.model(Block.name, BlockSchema);
    // Text indexes build asynchronously — wait for them before running $text queries.
    await Promise.all([
      UserModel.ensureIndexes(),
      ChatModel.ensureIndexes(),
      MessageModel.ensureIndexes(),
    ]);

    ContactModel = connection.model(Contact.name, ContactSchema);
    const { SearchService } = await import("./search.service");
    const { PeopleDiscoveryService } =
      await import("src/user/people-discovery.service");
    service = new SearchService(
      UserModel,
      ChatModel,
      MessageModel,
      ChatMembersModel,
      BlockModel,
      new PeopleDiscoveryService(
        UserModel,
        BlockModel,
        ContactModel,
        ChatModel,
        ChatMembersModel,
        privacyServiceFor(connection),
      ),
      privacyServiceFor(connection),
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all([
      UserModel.deleteMany({}),
      ChatModel.deleteMany({}),
      MessageModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
      BlockModel.deleteMany({}),
      ContactModel.deleteMany({}),
    ]);
  });

  describe("scope=people", () => {
    it("matches by username/name but a phone-number query never matches anyone", async () => {
      const me = await UserModel.create({
        username: "me",
        email: "me@example.com",
        password: "hashed",
      });
      await UserModel.create({
        username: "alicewonder",
        firstName: "Alice",
        email: "alice@example.com",
        password: "hashed",
        phoneNumber: "+15551234567",
      });

      const byName = await service.search(
        SearchScope.PEOPLE,
        "alicewonder",
        me._id.toString(),
      );
      expect(byName.map((u: { username: string }) => u.username)).toEqual([
        "alicewonder",
      ]);

      const byPhone = await service.search(
        SearchScope.PEOPLE,
        "+15551234567",
        me._id.toString(),
      );
      expect(byPhone).toEqual([]);
    });

    it("excludes the caller and anyone the caller has blocked", async () => {
      const me = await UserModel.create({
        username: "searcherxyz",
        email: "s@example.com",
        password: "hashed",
      });
      const blocked = await UserModel.create({
        username: "blockedxyz",
        email: "b@example.com",
        password: "hashed",
      });
      await BlockModel.create({ blockerId: me._id, blockedId: blocked._id });

      const results = await service.search(
        SearchScope.PEOPLE,
        "xyz",
        me._id.toString(),
      );
      expect(results.map((u: { username: string }) => u.username)).toEqual([]);
    });

    describe("privacy: who can find whom", () => {
      let seq = 0;
      const mk = (o: Partial<User> = {}) =>
        UserModel.create({
          username: `user${++seq}x`,
          email: `u${seq}@example.com`,
          password: "hashed",
          phoneNumber: `+1555000${seq}`,
          ...o,
        });
      const names = (r: unknown[]) =>
        (r as { username: string }[]).map(u => u.username).sort();
      const people = (q: string, me: { _id: Types.ObjectId }) =>
        service.search(SearchScope.PEOPLE, q, me._id.toString());
      async function shareChat(
        type: ChatType,
        members: { _id: Types.ObjectId }[],
        roles: UserRole[] = [],
      ) {
        const chat = await ChatModel.create({
          link: `c${++seq}`,
          type,
          name: `chat ${seq}`,
        });
        await ChatMembersModel.create(
          members.map((m, i) => ({
            channelId: String(chat._id),
            userId: String(m._id),
            role: roles[i] ?? UserRole.MEMBER,
          })),
        );
        return chat;
      }

      it("a stranger never matches by name", async () => {
        const me = await mk();
        await mk({
          username: "zarazara",
          firstName: "Zahra",
          lastName: "Karimi",
        });
        expect(await people("Zahra", me)).toEqual([]);
        expect(await people("Karimi", me)).toEqual([]);
        expect(await people("Zahra Karimi", me)).toEqual([]);
        // A partial username shorter than 4 chars is not enough either.
        expect(await people("zar", me)).toEqual([]);
      });

      it("a saved contact matches by name", async () => {
        const me = await mk();
        const friend = await mk({ username: "friendly1", firstName: "Zahra" });
        await ContactModel.create({
          ownerId: me._id.toString(),
          userId: friend._id.toString(),
        });
        expect(names(await people("zah", me))).toEqual(["friendly1"]);
        // Saving someone doesn't make *you* name-searchable by them.
        expect(await people("me", friend)).toEqual([]);
      });

      it("people sharing a DM or group match by name; channel subscribers don't", async () => {
        const me = await mk({ firstName: "Me" });
        const dm = await mk({ username: "dmmate", firstName: "Reza" });
        const groupie = await mk({
          username: "groupmate",
          firstName: "Reza",
          findByUsername: "nobody",
        });
        const subscriber = await mk({
          username: "subscriber",
          firstName: "Reza",
        });
        const otherSub = await mk({ username: "othersub", firstName: "Reza" });
        await shareChat(ChatType.PRIVATE, [me, dm]);
        await shareChat(ChatType.GROUP, [me, groupie]);
        await shareChat(ChatType.CHANNEL, [me, subscriber]);
        expect(names(await people("reza", me))).toEqual([
          "dmmate",
          "groupmate",
        ]);
        // Left the group → no longer "known".
        await ChatMembersModel.updateOne(
          { userId: String(groupie._id) },
          { isJoined: false },
        );
        expect(names(await people("reza", me))).toEqual(["dmmate"]);
        // A channel's admin does see its subscribers.
        await shareChat(
          ChatType.CHANNEL,
          [me, otherSub],
          [UserRole.OWNER, UserRole.MEMBER],
        );
        expect(names(await people("reza", me))).toEqual(["dmmate", "othersub"]);
      });

      it("a stranger is found by @username (exact, or a prefix of 4+ chars) when set to everybody", async () => {
        const me = await mk();
        await mk({ username: "kamran_star", firstName: "Kamran" });
        expect(names(await people("@kamran_star", me))).toEqual([
          "kamran_star",
        ]);
        expect(names(await people("kamran_star", me))).toEqual(["kamran_star"]);
        expect(names(await people("kamr", me))).toEqual(["kamran_star"]);
        expect(await people("kam", me)).toEqual([]);
        // Not a mid-word match for strangers.
        expect(await people("star", me)).toEqual([]);
        await mk({ username: "abc" });
        expect(names(await people("abc", me))).toEqual(["abc"]);
      });

      it("'nobody' hides a stranger even by exact username", async () => {
        const me = await mk();
        await mk({ username: "ghostuser", findByUsername: "nobody" });
        expect(await people("@ghostuser", me)).toEqual([]);
      });

      it("'contacts' only lets people the target saved find them", async () => {
        const me = await mk();
        const other = await mk();
        const target = await mk({
          username: "selective",
          findByUsername: "contacts",
        });
        expect(await people("selective", me)).toEqual([]);
        await ContactModel.create({
          ownerId: target._id.toString(),
          userId: me._id.toString(),
        });
        expect(names(await people("selective", me))).toEqual(["selective"]);
        expect(await people("selective", other)).toEqual([]);
      });

      it("blocks hide people in both directions, even contacts", async () => {
        const me = await mk();
        const blocksMe = await mk({ username: "blocksme1", firstName: "Sara" });
        const iBlocked = await mk({ username: "iblocked1", firstName: "Sara" });
        await ContactModel.create([
          { ownerId: me._id.toString(), userId: blocksMe._id.toString() },
          { ownerId: me._id.toString(), userId: iBlocked._id.toString() },
        ]);
        await BlockModel.create([
          { blockerId: blocksMe._id, blockedId: me._id },
          { blockerId: me._id, blockedId: iBlocked._id },
        ]);
        expect(await people("sara", me)).toEqual([]);
        expect(await people("blocksme1", me)).toEqual([]);
        expect(await people("iblocked1", me)).toEqual([]);
      });

      it("never returns email or phone in a stranger's result", async () => {
        const me = await mk();
        await mk({ username: "openbook", findByPhoneOrEmail: "everybody" });
        const [hit] = (await people("openbook", me)) as unknown as Record<
          string,
          unknown
        >[];
        expect(hit).toBeDefined();
        expect(Object.keys(hit).sort()).toEqual(
          [
            "_id",
            "avatarUrl",
            "bio",
            "firstName",
            "lastName",
            "username",
          ].sort(),
        );
        // And searching someone's phone/email finds nobody.
        expect(await people("+15550001", me)).toEqual([]);
        expect(await people("u1@example.com", me)).toEqual([]);
      });
    });

    it("rejects queries shorter than 2 characters", async () => {
      await expect(
        service.search(SearchScope.PEOPLE, "a", "someUserId"),
      ).rejects.toThrow(/at least 2/i);
    });
  });

  describe("scope=channels", () => {
    it("matches public groups/channels by name prefix, never private or DM chats", async () => {
      await ChatModel.create({
        link: "g1",
        type: ChatType.GROUP,
        name: "Rocket Fans",
        description: "For rocket enthusiasts",
        isPublic: true,
      });
      await ChatModel.create({
        link: "g2",
        type: ChatType.GROUP,
        name: "Rocket Club (private)",
        isPublic: false,
      });
      await ChatModel.create({
        link: "private-a-b",
        type: ChatType.PRIVATE,
        name: "Rocket Fans DM",
      });

      const results = await service.search(
        SearchScope.CHANNELS,
        "rocket",
        "someUserId",
      );
      expect(results).toHaveLength(1);
      expect((results[0] as { name: string }).name).toBe("Rocket Fans");
      // Partial words match too ("rock" → "Rocket").
      expect(
        await service.search(SearchScope.CHANNELS, "rock", "someUserId"),
      ).toHaveLength(1);
      // Regex metacharacters are literal, not patterns.
      expect(
        await service.search(SearchScope.CHANNELS, "r.*", "someUserId"),
      ).toHaveLength(0);
    });
  });

  describe("scope=messages", () => {
    it("only matches messages in channels the caller is a member of", async () => {
      const userId = new Types.ObjectId().toString();
      const myChannel = "channelA";
      const otherChannel = "channelB";
      await ChatMembersModel.create({
        channelId: myChannel,
        userId,
        role: UserRole.MEMBER,
      });
      await MessageModel.create({
        channelId: myChannel,
        senderId: new Types.ObjectId(),
        content: "let's discuss dinosaurs today",
      });
      await MessageModel.create({
        channelId: otherChannel,
        senderId: new Types.ObjectId(),
        content: "dinosaurs are cool too",
      });

      const results = await service.search(
        SearchScope.MESSAGES,
        "dinosaurs",
        userId,
      );
      expect(results).toHaveLength(1);
      expect((results[0] as { channelId: string }).channelId).toBe(myChannel);
    });
  });

  describe("searchInChannel (snippet + cursor)", () => {
    it("rejects a non-member", async () => {
      await expect(
        service.searchInChannel("someChannel", "notAMember", "hello"),
      ).rejects.toThrow(/access denied/i);
    });

    it("returns snippet + cursor windows, newest first", async () => {
      const userId = new Types.ObjectId().toString();
      const channelId = "channelC";
      await ChatMembersModel.create({
        channelId,
        userId,
        role: UserRole.MEMBER,
      });
      for (let i = 0; i < 3; i++) {
        await MessageModel.create({
          channelId,
          senderId: new Types.ObjectId(),
          content: `banana split number ${i}`,
          createdAt: new Date(Date.now() - (3 - i) * 60_000),
        });
      }

      const page1 = await service.searchInChannel(
        channelId,
        userId,
        "banana",
        2,
      );
      expect(page1.items).toHaveLength(2);
      expect(page1.items[0].snippet).toContain("banana split number 2");
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await service.searchInChannel(
        channelId,
        userId,
        "banana",
        2,
        page1.nextCursor,
      );
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
    });
  });
});
