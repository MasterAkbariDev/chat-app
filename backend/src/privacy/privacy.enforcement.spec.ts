import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Block, BlockSchema } from "src/user/schema/block.schema";
import { Contact, ContactSchema } from "src/contacts/schema/contact.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { ChatState, ChatStateSchema } from "src/chat/schema/chat-state.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import {
  MessageReaction,
  MessageReactionSchema,
} from "src/message/schema/message-reaction.schema";
import { ChatType, UserRole } from "src/enum/base.enum";
import { PrivacyService } from "./privacy.service";
import { PeopleDiscoveryService } from "src/user/people-discovery.service";
import { ChannelsService } from "src/channels/channels.service";
import type { FoldersService } from "src/folders/folders.service";
import type { UserService as UserServiceT } from "src/user/user.service";
import type { ChatService as ChatServiceT } from "src/chat/chat.service";
import type { CallsService as CallsServiceT } from "src/calls/calls.service";
import type { MessageService as MessageServiceT } from "src/message/message.service";
import type { PresenceService } from "src/presence/presence.service";
import type { TokenCacheService } from "src/auth/token-cache.service";
import type { PacksService } from "src/packs/packs.service";
import type { ChatGateway } from "src/gateway/chat.gateway";
import type { EventEmitter2 } from "eventemitter2";
import type { CallStateService, CallState } from "src/calls/call-state.service";
import type { LiveKitTokenService } from "src/calls/livekit-token.service";

/**
 * Every place another user's data is shown goes through PrivacyService — these tests drive the
 * real services (profile, photos, status, discovery, chat list, members, add-to-group, calls,
 * forwards) against a real Mongo to prove each setting is enforced where it matters.
 */
describe("privacy enforcement across services", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let BlockModel: Model<Block>;
  let ContactModel: Model<Contact>;
  let ChatModel: Model<Chat>;
  let MembersModel: Model<ChatMembers>;
  let MessageModel: Model<Message>;
  let privacy: PrivacyService;
  let users: UserServiceT;
  let chats: ChatServiceT;
  let calls: CallsServiceT;
  let messages: MessageServiceT;
  let discovery: PeopleDiscoveryService;
  let channels: ChannelsService;
  let online = new Set<string>();
  let seq = 0;

  beforeAll(async () => {
    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    BlockModel = connection.model(Block.name, BlockSchema);
    ContactModel = connection.model(Contact.name, ContactSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    MembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    connection.model(ChatState.name, ChatStateSchema);
    MessageModel = connection.model(Message.name, MessageSchema);
    const ReactionModel = connection.model(
      MessageReaction.name,
      MessageReactionSchema,
    );
    privacy = new PrivacyService(UserModel, ContactModel);

    const fakePresence = {
      isOnline: (uid: string) => Promise.resolve(online.has(uid)),
    } as unknown as PresenceService;
    const { UserService } = await import("src/user/user.service");
    users = new UserService(
      UserModel,
      BlockModel,
      ContactModel,
      fakePresence,
      {} as TokenCacheService,
      {} as PacksService,
      privacy,
    );
    const fakeGateway = {
      notifyNewChat: jest.fn(),
      notifyCallRinging: jest.fn(),
    } as unknown as ChatGateway;
    const fakeEmitter = { emit: jest.fn() } as unknown as EventEmitter2;
    const { ChatService } = await import("src/chat/chat.service");
    chats = new ChatService(
      ChatModel,
      MembersModel,
      UserModel,
      MessageModel,
      fakeGateway,
      fakeEmitter,
      privacy,
    );
    discovery = new PeopleDiscoveryService(
      UserModel,
      BlockModel,
      ContactModel,
      ChatModel,
      MembersModel,
      privacy,
    );
    channels = new ChannelsService(
      MembersModel,
      { getOwnedFolder: jest.fn() } as unknown as FoldersService,
      privacy,
    );
    const { MessageService } = await import("src/message/message.service");
    messages = new MessageService(
      MessageModel,
      ReactionModel,
      MembersModel,
      ChatModel,
      UserModel,
      {} as never,
      fakeEmitter,
      {} as PacksService,
      privacy,
    );
    const store = new Map<string, CallState>();
    const fakeCallState = {
      create: (s: CallState) => Promise.resolve(void store.set(s.callId, s)),
      get: (cid: string) => Promise.resolve(store.get(cid) ?? null),
      save: (s: CallState) => Promise.resolve(void store.set(s.callId, s)),
      getActivePrivateCallIdForChannel: () => Promise.resolve(null),
      getActiveCallIdForChannel: () => Promise.resolve(null),
      claimChannel: () => Promise.resolve(true),
      delete: () => Promise.resolve(),
    } as unknown as CallStateService;
    const fakeLiveKit = {
      createRoomToken: jest.fn().mockResolvedValue("jwt"),
      livekitUrl: "ws://lk",
    };
    const { CallsService } = await import("src/calls/calls.service");
    calls = new CallsService(
      MembersModel,
      ChatModel,
      UserModel,
      BlockModel,
      fakeCallState,
      fakeLiveKit as unknown as LiveKitTokenService,
      {} as MessageServiceT,
      fakeGateway,
      privacy,
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    online = new Set();
    await Promise.all(
      [
        UserModel,
        BlockModel,
        ContactModel,
        ChatModel,
        MembersModel,
        MessageModel,
      ].map(m => (m as Model<unknown>).deleteMany({})),
    );
  });

  const mk = (o: Partial<User> = {}) =>
    UserModel.create({
      username: `en${++seq}x`,
      firstName: `First${seq}`,
      email: `en${seq}@example.com`,
      phoneNumber: `+9891200${String(seq).padStart(5, "0")}`,
      password: "hashed",
      image: [`/uploads/media/en${seq}.jpg`],
      photos: [{ url: `/uploads/media/en${seq}.jpg`, kind: "image" }],
      bio: `bio ${seq}`,
      ...o,
    });
  const id = (u: { _id: Types.ObjectId }) => u._id.toString();
  const save = (
    owner: { _id: Types.ObjectId },
    saved: { _id: Types.ObjectId },
  ) => ContactModel.create({ ownerId: id(owner), userId: id(saved) });
  async function dm(a: { _id: Types.ObjectId }, b: { _id: Types.ObjectId }) {
    const chat = await ChatModel.create({
      type: ChatType.PRIVATE,
      link: `dm-${id(a)}-${id(b)}`,
      name: "",
    });
    await MembersModel.insertMany([
      { channelId: String(chat._id), userId: id(a), role: UserRole.MEMBER },
      { channelId: String(chat._id), userId: id(b), role: UserRole.MEMBER },
    ]);
    return String(chat._id);
  }
  async function group(owner: { _id: Types.ObjectId }) {
    const chat = await ChatModel.create({
      type: ChatType.GROUP,
      link: `g-${++seq}`,
      name: "G",
    });
    await MembersModel.create({
      channelId: String(chat._id),
      userId: id(owner),
      role: UserRole.OWNER,
    });
    return String(chat._id);
  }

  describe("profile view (GET /users/by-id/:id)", () => {
    it("phone: contacts by default (target saved viewer), email: nobody; owner sees all", async () => {
      const t = await mk();
      const v = await mk();
      let p = await users.findOne(id(t), id(v));
      expect(p.phoneNumber).toBeUndefined();
      expect(p.email).toBeUndefined();
      await save(t, v);
      p = await users.findOne(id(t), id(v));
      expect(p.phoneNumber).toBe(t.phoneNumber);
      expect(p.email).toBeUndefined();
      await privacy.updateSettings(id(t), { email: { allow: [id(v)] } });
      p = await users.findOne(id(t), id(v));
      expect(p.email).toBe(t.email);
      const own = await users.findOne(id(t), id(t));
      expect(own.phoneNumber).toBe(t.phoneNumber);
      expect(own.email).toBe(t.email);
    });

    it("never-allow beats contacts; photos/bio hidden per rule; canCall / canAddToGroups", async () => {
      const t = await mk();
      const v = await mk();
      await save(t, v);
      await privacy.updateSettings(id(t), {
        phoneNumber: { deny: [id(v)] },
        profilePhotos: "nobody",
        bio: "nobody",
        calls: "nobody",
        groupInvites: { audience: "contacts", deny: [id(v)] },
      });
      const p = await users.findOne(id(t), id(v));
      expect(p.phoneNumber).toBeUndefined();
      expect(p.avatarUrl).toEqual([]);
      expect(p.bio).toBe("");
      expect(p.canCall).toBe(false);
      expect(p.canAddToGroups).toBe(false);
      expect(await users.listPhotosFor(id(t), id(v))).toEqual([]);
      expect(await users.listPhotosFor(id(t), id(t))).toHaveLength(1);
    });

    it("a block (either way) turns calls off even when privacy allows", async () => {
      const t = await mk();
      const v = await mk();
      await BlockModel.create({ blockerId: t._id, blockedId: v._id });
      const p = await users.findOne(id(t), id(v));
      expect(p.canCall).toBe(false);
      expect(p.canAddToGroups).toBe(false);
    });
  });

  describe("status (GET /users/:id/status)", () => {
    it("exact when allowed both ways, bucket otherwise (reciprocal)", async () => {
      const t = await mk({ lastSeen: new Date(Date.now() - 10 * 86_400_000) });
      const v = await mk();
      online.add(id(t));
      expect(await users.getUserStatus(id(t), id(v))).toMatchObject({
        isOnline: true,
      });
      await privacy.updateSettings(id(v), { lastSeen: "nobody" }); // viewer hides theirs
      expect(await users.getUserStatus(id(t), id(v))).toEqual({
        userId: id(t),
        isOnline: false,
        lastSeen: null,
        lastSeenBucket: "recently",
      });
      online.clear();
      expect((await users.getUserStatus(id(t), id(v))).lastSeenBucket).toBe(
        "within_month",
      );
    });
  });

  describe("discovery exceptions", () => {
    it("findByUsername: never-allow hides from a stranger, always-allow reveals under nobody", async () => {
      const t = await mk({ username: "privacytarget" });
      const a = await mk();
      const b = await mk();
      await privacy.updateSettings(id(t), {
        findByUsername: { deny: [id(a)] },
      });
      expect(
        await discovery.resolveExact(id(a), { username: "privacytarget" }),
      ).toBeNull();
      expect(
        await discovery.resolveExact(id(b), { username: "privacytarget" }),
      ).toBe(id(t));
      await privacy.updateSettings(id(t), {
        findByUsername: { audience: "nobody", allow: [id(b)], deny: [] },
      });
      expect(
        await discovery.resolveExact(id(b), { username: "privacytarget" }),
      ).toBe(id(t));
      expect(
        await discovery.searchPeople("privacytarget", id(a), 10, 0),
      ).toEqual([]);
    });

    it("search results carry photos only when allowed", async () => {
      const t = await mk({ username: "photohidden" });
      const v = await mk();
      await privacy.updateSettings(id(t), { profilePhotos: "nobody" });
      const [hit] = await discovery.searchPeople("photohidden", id(v), 10, 0);
      expect(hit._id).toBe(id(t));
      expect(hit.avatarUrl).toEqual([]);
    });
  });

  describe("chat list, members", () => {
    it("otherUser in /v1/channels/mine and member lists follow the target's privacy", async () => {
      const t = await mk();
      const v = await mk();
      const friend = await mk();
      await dm(t, v);
      await privacy.updateSettings(id(t), {
        profilePhotos: { audience: "nobody", allow: [id(friend)] },
        bio: "nobody",
      });
      const { items } = await channels.listMine(id(v));
      expect(items[0].otherUser?._id).toBe(id(t));
      expect(items[0].otherUser?.avatarUrl).toEqual([]);
      expect(items[0].otherUser?.bio).toBe("");

      const g = await group(friend);
      await MembersModel.insertMany([
        { channelId: g, userId: id(t), role: UserRole.MEMBER },
        { channelId: g, userId: id(v), role: UserRole.MEMBER },
      ]);
      const asV = await chats.getParticipants(g, id(v));
      expect(asV.find(m => m.userId === id(t))?.avatarUrl).toEqual([]);
      const asFriend = await chats.getParticipants(g, id(friend));
      expect(asFriend.find(m => m.userId === id(t))?.avatarUrl).toEqual(
        t.image,
      );
    });
  });

  describe("groups & channels (who can add me)", () => {
    it("addMembers skips people whose privacy doesn't allow the adder", async () => {
      const owner = await mk();
      const open = await mk();
      const closed = await mk();
      const contactsOnly = await mk();
      await privacy.updateSettings(id(closed), { groupInvites: "nobody" });
      await privacy.updateSettings(id(contactsOnly), {
        groupInvites: "contacts",
      });
      await save(contactsOnly, owner);
      const g = await group(owner);
      const res = await chats.addMembers(
        g,
        [id(open), id(closed), id(contactsOnly)],
        id(owner),
      );
      expect(res.added.sort()).toEqual([id(open), id(contactsOnly)].sort());
      expect(res.restricted).toEqual([id(closed)]);
      expect(
        await MembersModel.exists({ channelId: g, userId: id(closed) }),
      ).toBeNull();

      // An exception lets this one adder in.
      await privacy.updateSettings(id(closed), {
        groupInvites: { allow: [id(owner)] },
      });
      const again = await chats.addMembers(g, [id(closed)], id(owner));
      expect(again.added).toEqual([id(closed)]);
    });

    it("creating a group leaves restricted people out and reports them", async () => {
      const owner = await mk();
      const ok = await mk();
      const no = await mk();
      await privacy.updateSettings(id(no), { groupInvites: "nobody" });
      const created = (await chats.create(
        {
          name: "New",
          type: ChatType.GROUP,
          link: `new-${++seq}`,
          members: [id(ok), id(no)],
        },
        id(owner),
      )) as unknown as { _id: Types.ObjectId; restrictedMemberIds: string[] };
      expect(created.restrictedMemberIds).toEqual([id(no)]);
      const ids = await MembersModel.distinct("userId", {
        channelId: String(created._id),
      });
      expect(ids.sort()).toEqual([id(owner), id(ok)].sort());
    });
  });

  describe("calls (who can call me)", () => {
    it("private calls need the callee's permission, with a clear error", async () => {
      const callee = await mk({ firstName: "Sara", lastName: "" });
      const caller = await mk();
      const friend = await mk();
      const c1 = await dm(caller, callee);
      const c2 = await dm(friend, callee);
      await privacy.updateSettings(id(callee), {
        calls: { audience: "nobody", allow: [id(friend)] },
      });
      await expect(calls.createCall(c1, id(caller))).rejects.toThrow(
        "Sara doesn't accept calls from you",
      );
      await expect(calls.createCall(c2, id(friend))).resolves.toMatchObject({
        roomToken: "jwt",
      });
    });

    it("participant metadata carries the photo only if the other side may see it", async () => {
      const a = await mk();
      const b = await mk();
      const chat = await dm(a, b);
      await privacy.updateSettings(id(a), { profilePhotos: "nobody" });
      const lk = (
        calls as unknown as {
          liveKitToken: {
            createRoomToken: jest.Mock<Promise<string>, string[]>;
          };
        }
      ).liveKitToken;
      lk.createRoomToken.mockClear();
      await calls.createCall(chat, id(a));
      const metadata = lk.createRoomToken.mock.calls[0][3];
      expect(JSON.parse(metadata)).toEqual({ photo: null });
    });
  });

  describe("forwarded messages", () => {
    it("links the original sender only when their forwards privacy allows the forwarder", async () => {
      const author = await mk({ firstName: "Omid", lastName: "" });
      const forwarder = await mk();
      const src = await group(author);
      await MembersModel.create({
        channelId: src,
        userId: id(forwarder),
        role: UserRole.MEMBER,
      });
      const dst = await group(forwarder);
      const original = await MessageModel.create({
        channelId: src,
        senderId: author._id,
        content: "hello",
        type: "text",
      });

      const linked = await messages.create(
        {
          channelId: dst,
          content: "",
          forwardFrom: String(original._id),
        },
        id(forwarder),
      );
      expect(JSON.parse(JSON.stringify(linked.forwardFrom))).toMatchObject({
        name: "Omid",
        userId: id(author),
        avatarUrl: author.image[0],
      });

      await privacy.updateSettings(id(author), { forwards: "nobody" });
      const hidden = await messages.create(
        {
          channelId: dst,
          content: "",
          forwardFrom: String(original._id),
        },
        id(forwarder),
      );
      expect(JSON.parse(JSON.stringify(hidden.forwardFrom))).toEqual({
        name: "Omid",
        hidden: true,
      });

      // Forwarding that forward keeps it unlinked.
      const again = await messages.create(
        {
          channelId: dst,
          content: "",
          forwardFrom: String(hidden._id),
        },
        id(forwarder),
      );
      expect(JSON.parse(JSON.stringify(again.forwardFrom))).toMatchObject({
        name: "Omid",
        hidden: true,
      });
      expect((again.forwardFrom as { userId?: string }).userId).toBeUndefined();
    });

    it("message history hides a sender's photo from viewers it's hidden from", async () => {
      const a = await mk();
      const b = await mk();
      const chat = await dm(a, b);
      await MessageModel.create({
        channelId: chat,
        senderId: a._id,
        content: "hi",
        type: "text",
      });
      await privacy.updateSettings(id(a), { profilePhotos: "nobody" });
      const asB = await messages.findAll(chat, id(b));
      expect(
        (asB[0].senderId as unknown as { avatarUrl: string[] }).avatarUrl,
      ).toEqual([]);
      const asA = await messages.findAll(chat, id(a));
      expect(
        (asA[0].senderId as unknown as { avatarUrl: string[] }).avatarUrl,
      ).toEqual(a.image);
    });
  });
});
