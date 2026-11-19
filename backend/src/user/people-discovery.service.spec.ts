import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { User, UserSchema } from "./schema/user.schema";
import { Block, BlockSchema } from "./schema/block.schema";
import { Contact, ContactSchema } from "src/contacts/schema/contact.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { ChatType, UserRole } from "src/enum/base.enum";
import { privacyOf } from "./schema/privacy";
import { toMeDto } from "src/common/dto/user-view.dto";
import { PeopleDiscoveryService } from "./people-discovery.service";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("PeopleDiscoveryService (who can find whom)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let BlockModel: Model<Block>;
  let ContactModel: Model<Contact>;
  let ChatModel: Model<Chat>;
  let ChatMembersModel: Model<ChatMembers>;
  let service: PeopleDiscoveryService;
  let seq = 0;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    BlockModel = connection.model(Block.name, BlockSchema);
    ContactModel = connection.model(Contact.name, ContactSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    service = new PeopleDiscoveryService(
      UserModel,
      BlockModel,
      ContactModel,
      ChatModel,
      ChatMembersModel,
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
      BlockModel.deleteMany({}),
      ContactModel.deleteMany({}),
      ChatModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
    ]);
  });

  const mk = (o: Partial<User> = {}) =>
    UserModel.create({
      username: `person${++seq}z`,
      email: `p${seq}@example.com`,
      phoneNumber: `+98912000${String(seq).padStart(4, "0")}`,
      password: "hashed",
      ...o,
    });
  const id = (u: { _id: Types.ObjectId }) => u._id.toString();
  const save = (
    owner: { _id: Types.ObjectId },
    saved: { _id: Types.ObjectId },
  ) => ContactModel.create({ ownerId: id(owner), userId: id(saved) });

  it("defaults: username findable by everybody, phone/email by contacts only", async () => {
    const u = await mk();
    expect(privacyOf(u)).toMatchObject({
      findByUsername: "everybody",
      findByPhoneOrEmail: "contacts",
    });
    // Documents created before the fields existed read as the defaults.
    expect(privacyOf({})).toMatchObject({
      findByUsername: "everybody",
      findByPhoneOrEmail: "contacts",
    });
    expect(toMeDto(u).privacy).toEqual(privacyOf(u));
  });

  it("legacy documents without the fields follow the defaults in queries", async () => {
    const me = await mk();
    const legacy = await mk({ username: "oldtimer" });
    await UserModel.collection.updateOne(
      { _id: legacy._id },
      { $unset: { findByUsername: "", findByPhoneOrEmail: "" } },
    );
    expect(await service.resolveExact(id(me), { username: "oldtimer" })).toBe(
      id(legacy),
    );
    expect(
      await service.resolveExact(id(me), { phone: legacy.phoneNumber }),
    ).toBeNull();
    await save(legacy, me);
    expect(
      await service.resolveExact(id(me), { phone: legacy.phoneNumber }),
    ).toBe(id(legacy));
  });

  describe("resolveExact by username", () => {
    it("everybody → found; nobody → hidden; contacts → only people they saved", async () => {
      const me = await mk();
      const t = await mk({ username: "targetname" });
      expect(
        await service.resolveExact(id(me), { username: "@TargetName" }),
      ).toBe(id(t));

      await UserModel.updateOne({ _id: t._id }, { findByUsername: "nobody" });
      expect(
        await service.resolveExact(id(me), { username: "targetname" }),
      ).toBeNull();

      await UserModel.updateOne({ _id: t._id }, { findByUsername: "contacts" });
      expect(
        await service.resolveExact(id(me), { username: "targetname" }),
      ).toBeNull();
      // Me saving them doesn't count — they must have saved me.
      await save(me, t);
      expect(
        await service.resolveExact(id(me), { username: "targetname" }),
      ).toBe(id(t));
      await ContactModel.deleteMany({});
      await save(t, me);
      expect(
        await service.resolveExact(id(me), { username: "targetname" }),
      ).toBe(id(t));
    });

    it("people who share a group can still open each other by username under 'nobody'", async () => {
      const me = await mk();
      const mate = await mk({
        username: "groupmate",
        findByUsername: "nobody",
      });
      const chat = await ChatModel.create({
        link: `g${++seq}`,
        type: ChatType.GROUP,
        name: "g",
      });
      await ChatMembersModel.create([
        { channelId: String(chat._id), userId: id(me), role: UserRole.MEMBER },
        {
          channelId: String(chat._id),
          userId: id(mate),
          role: UserRole.MEMBER,
        },
      ]);
      expect(
        await service.resolveExact(id(me), { username: "groupmate" }),
      ).toBe(id(mate));
    });

    it("a hidden user and a non-existent one look the same", async () => {
      const me = await mk();
      await mk({ username: "hiddenone", findByUsername: "nobody" });
      const hidden = await service.resolveExact(id(me), {
        username: "hiddenone",
      });
      const missing = await service.resolveExact(id(me), {
        username: "nosuchone",
      });
      expect(hidden).toBeNull();
      expect(missing).toBeNull();
    });
  });

  describe("resolveExact by phone / email", () => {
    it("exact match only, gated by findByPhoneOrEmail", async () => {
      const me = await mk();
      const t = await mk({
        phoneNumber: "+989121112233",
        email: "Exact@Example.com",
        findByPhoneOrEmail: "everybody",
      });
      expect(
        await service.resolveExact(id(me), { phone: "+989121112233" }),
      ).toBe(id(t));
      expect(
        await service.resolveExact(id(me), { phone: "+98912111223" }),
      ).toBeNull();
      expect(
        await service.resolveExact(id(me), { email: "exact@example.com" }),
      ).toBe(id(t));
      expect(
        await service.resolveExact(id(me), { email: "exact@example" }),
      ).toBeNull();

      await UserModel.updateOne(
        { _id: t._id },
        { findByPhoneOrEmail: "nobody" },
      );
      await save(t, me);
      expect(
        await service.resolveExact(id(me), { phone: "+989121112233" }),
      ).toBeNull();
    });

    it("sharing a chat does not unlock phone/email lookups", async () => {
      const me = await mk();
      const mate = await mk({ phoneNumber: "+989120001111" });
      const chat = await ChatModel.create({
        link: `d${++seq}`,
        type: ChatType.PRIVATE,
        name: "dm",
      });
      await ChatMembersModel.create([
        { channelId: String(chat._id), userId: id(me), role: UserRole.MEMBER },
        {
          channelId: String(chat._id),
          userId: id(mate),
          role: UserRole.MEMBER,
        },
      ]);
      expect(
        await service.resolveExact(id(me), { phone: "+989120001111" }),
      ).toBeNull();
    });
  });

  it("blocks hide people in both directions for every lookup", async () => {
    const me = await mk();
    const a = await mk({
      username: "blockera",
      findByPhoneOrEmail: "everybody",
    });
    const b = await mk({
      username: "blockedb",
      findByPhoneOrEmail: "everybody",
    });
    await save(me, a);
    await save(me, b);
    await BlockModel.create([
      { blockerId: a._id, blockedId: me._id },
      { blockerId: me._id, blockedId: b._id },
    ]);
    for (const t of [a, b]) {
      expect(
        await service.resolveExact(id(me), { username: t.username }),
      ).toBeNull();
      expect(await service.resolveExact(id(me), { email: t.email })).toBeNull();
      expect(
        await service.resolveExact(id(me), { phone: t.phoneNumber }),
      ).toBeNull();
      expect(await service.searchPeople(t.username, id(me), 20, 0)).toEqual([]);
    }
    // And the other way round.
    expect(await service.searchPeople(me.username, id(a), 20, 0)).toEqual([]);
    expect(await service.searchPeople(me.username, id(b), 20, 0)).toEqual([]);
  });

  it("search results never carry email or phone, for contacts or strangers", async () => {
    const me = await mk();
    const friend = await mk({ username: "friendzz", firstName: "Nima" });
    await mk({ username: "strangerzz", findByPhoneOrEmail: "everybody" });
    await save(me, friend);
    await save(friend, me);
    const results = [
      ...(await service.searchPeople("nima", id(me), 20, 0)),
      ...(await service.searchPeople("strangerzz", id(me), 20, 0)),
    ];
    expect(results).toHaveLength(2);
    for (const r of results) {
      const json = JSON.stringify(r);
      expect(json).not.toMatch(/@example\.com|\+98912|email|phone/i);
    }
  });
});
