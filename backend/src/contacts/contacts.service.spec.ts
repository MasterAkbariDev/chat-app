import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Contact, ContactSchema } from "./schema/contact.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { ChatState, ChatStateSchema } from "src/chat/schema/chat-state.schema";
import { ChatType } from "src/enum/base.enum";
import { Block, BlockSchema } from "src/user/schema/block.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { privateChatLink } from "src/chat/private-chat-link.util";
import type { ContactsService as ContactsServiceType } from "./contacts.service";
import type { PresenceService } from "src/presence/presence.service";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("ContactsService (B6: address book)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ContactModel: Model<Contact>;
  let UserModel: Model<User>;
  let ChatModel: Model<Chat>;
  let ChatStateModel: Model<ChatState>;
  let BlockModel: Model<Block>;
  let service: ContactsServiceType;
  let onlineUsers: Set<string>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ContactModel = connection.model(Contact.name, ContactSchema);
    UserModel = connection.model(User.name, UserSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    ChatStateModel = connection.model(ChatState.name, ChatStateSchema);

    onlineUsers = new Set<string>();
    const fakePresence = {
      isOnline: jest.fn((userId: string) =>
        Promise.resolve(onlineUsers.has(userId)),
      ),
    } as unknown as PresenceService;

    BlockModel = connection.model(Block.name, BlockSchema);
    const ChatMembersModel = connection.model(
      ChatMembers.name,
      ChatMembersSchema,
    );
    const { ContactsService } = await import("./contacts.service");
    const { PeopleDiscoveryService } =
      await import("src/user/people-discovery.service");
    service = new ContactsService(
      ContactModel,
      UserModel,
      ChatModel,
      ChatStateModel,
      fakePresence,
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
      ContactModel.deleteMany({}),
      UserModel.deleteMany({}),
      ChatModel.deleteMany({}),
      ChatStateModel.deleteMany({}),
      BlockModel.deleteMany({}),
    ]);
    onlineUsers.clear();
  });

  async function makeUser(overrides: Partial<User> = {}) {
    return UserModel.create({
      username: `user${Date.now()}${Math.random()}`.replace(".", ""),
      email: `${Date.now()}${Math.random()}@example.com`.replace(".", ""),
      password: "hashed",
      ...overrides,
    });
  }

  it("adds a contact by exact username", async () => {
    const owner = await makeUser();
    const other = await makeUser({ username: "alice" });

    const result = await service.addContact(owner._id.toString(), {
      username: "alice",
    });
    expect(result._id).toEqual(expect.any(String));

    const stored = await ContactModel.findById(result._id).lean().exec();
    expect(stored?.userId).toBe(other._id.toString());
  });

  it("adds a contact by exact phone or email but rejects partial matches", async () => {
    const owner = await makeUser();
    await makeUser({
      phoneNumber: "+15551234567",
      findByPhoneOrEmail: "everybody",
    });

    await expect(
      service.addContact(owner._id.toString(), { phone: "+1555123456" }),
    ).rejects.toThrow(/no user found/i);

    const result = await service.addContact(owner._id.toString(), {
      phone: "+15551234567",
    });
    expect(result._id).toEqual(expect.any(String));
  });

  describe("privacy (findByPhoneOrEmail / findByUsername)", () => {
    it("hides phone/email by default (contacts) unless the person saved you", async () => {
      const owner = await makeUser();
      const target = await makeUser({
        phoneNumber: "+989120000000",
        email: "target@example.com",
      });
      // Same 404 as a number nobody has.
      await expect(
        service.addContact(owner._id.toString(), { phone: "+989120000000" }),
      ).rejects.toThrow(/no user found/i);
      await expect(
        service.addContact(owner._id.toString(), {
          email: "target@example.com",
        }),
      ).rejects.toThrow(/no user found/i);
      await expect(
        service.addContact(owner._id.toString(), { phone: "+989129999999" }),
      ).rejects.toThrow(/no user found/i);

      // Once the target has saved the owner, "contacts" lets the owner find them.
      await ContactModel.create({
        ownerId: target._id.toString(),
        userId: owner._id.toString(),
      });
      await expect(
        service.addContact(owner._id.toString(), { phone: "+989120000000" }),
      ).resolves.toHaveProperty("_id");
    });

    it("email must be exact and respects 'nobody'", async () => {
      const owner = await makeUser();
      const target = await makeUser({
        email: "exact@example.com",
        findByPhoneOrEmail: "everybody",
      });
      await expect(
        service.addContact(owner._id.toString(), { email: "exact@example" }),
      ).rejects.toThrow(/no user found/i);
      await expect(
        service.addContact(owner._id.toString(), {
          email: "EXACT@example.com",
        }),
      ).resolves.toHaveProperty("_id");

      await ContactModel.deleteMany({});
      await UserModel.updateOne(
        { _id: target._id },
        { findByPhoneOrEmail: "nobody" },
      );
      // Even a person the target saved can't look them up by email under "nobody".
      await ContactModel.create({
        ownerId: target._id.toString(),
        userId: owner._id.toString(),
      });
      await expect(
        service.addContact(owner._id.toString(), {
          email: "exact@example.com",
        }),
      ).rejects.toThrow(/no user found/i);
    });

    it("username lookups respect findByUsername and blocks in both directions", async () => {
      const owner = await makeUser();
      const hidden = await makeUser({
        username: "hiddenperson",
        findByUsername: "nobody",
      });
      await expect(
        service.addContact(owner._id.toString(), { username: "hiddenperson" }),
      ).rejects.toThrow(/no user found/i);

      const blocker = await makeUser({ username: "blockerperson" });
      await BlockModel.create({ blockerId: blocker._id, blockedId: owner._id });
      await expect(
        service.addContact(owner._id.toString(), { username: "blockerperson" }),
      ).rejects.toThrow(/no user found/i);

      const blockedByMe = await makeUser({ username: "blockedperson" });
      await BlockModel.create({
        blockerId: owner._id,
        blockedId: blockedByMe._id,
      });
      await expect(
        service.addContact(owner._id.toString(), { username: "blockedperson" }),
      ).rejects.toThrow(/no user found/i);
      expect(hidden).toBeDefined();
    });
  });

  it("rejects adding yourself", async () => {
    const owner = await makeUser({ username: "self" });
    await expect(
      service.addContact(owner._id.toString(), { username: "self" }),
    ).rejects.toThrow(/yourself/i);
  });

  it("rejects a duplicate contact", async () => {
    const owner = await makeUser();
    await makeUser({ username: "bob" });
    await service.addContact(owner._id.toString(), { username: "bob" });

    await expect(
      service.addContact(owner._id.toString(), { username: "bob" }),
    ).rejects.toThrow(/already/i);
  });

  it("requires exactly one of userId/username/phone/email", async () => {
    const owner = await makeUser();
    await expect(
      service.addContact(owner._id.toString(), {
        username: "a",
        email: "b@example.com",
      }),
    ).rejects.toThrow(/exactly one/i);
    await expect(service.addContact(owner._id.toString(), {})).rejects.toThrow(
      /exactly one/i,
    );
  });

  it("adds a contact directly by userId (the 'Add contact' button path)", async () => {
    const owner = await makeUser();
    const other = await makeUser({ username: "eve" });

    const result = await service.addContact(owner._id.toString(), {
      userId: other._id.toString(),
    });
    const stored = await ContactModel.findById(result._id).lean().exec();
    expect(stored?.userId).toBe(other._id.toString());
  });

  it("rejects a userId that doesn't resolve to a real user", async () => {
    const owner = await makeUser();
    await expect(
      service.addContact(owner._id.toString(), {
        userId: new Types.ObjectId().toString(),
      }),
    ).rejects.toThrow(/no user found/i);
  });

  it("lists contacts with presence and existing-DM info", async () => {
    const owner = await makeUser();
    const contact = await makeUser({ username: "carol" });
    onlineUsers.add(contact._id.toString());

    await service.addContact(owner._id.toString(), { username: "carol" });

    const link = privateChatLink(owner._id.toString(), contact._id.toString());
    const chat = await ChatModel.create({ link, type: ChatType.PRIVATE });
    await ChatStateModel.create({
      channelId: chat._id.toString(),
      lastMessageAt: new Date("2024-05-01T00:00:00.000Z"),
      lastMessagePreview: "hey",
    });

    const list = await service.listContacts(owner._id.toString());
    expect(list).toHaveLength(1);
    expect(list[0].user.username).toBe("carol");
    expect(list[0].isOnline).toBe(true);
    expect(list[0].channelId).toBe(chat._id.toString());
    expect(list[0].lastMessagePreview).toBe("hey");
  });

  it("lists a contact with no existing DM as channelId: null", async () => {
    const owner = await makeUser();
    await makeUser({ username: "dave" });
    await service.addContact(owner._id.toString(), { username: "dave" });

    const list = await service.listContacts(owner._id.toString());
    expect(list[0].channelId).toBeNull();
    expect(list[0].lastMessageAt).toBeNull();
  });
});
