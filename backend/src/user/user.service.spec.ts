import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { User, UserSchema } from "./schema/user.schema";
import { Block, BlockSchema } from "./schema/block.schema";
import { Contact, ContactSchema } from "src/contacts/schema/contact.schema";
import type { UserService as UserServiceType } from "./user.service";
import type { PresenceService } from "src/presence/presence.service";
import type { TokenCacheService } from "src/auth/token-cache.service";
import type { PacksService } from "src/packs/packs.service";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("UserService (profile-page mutual-contact reveal)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let BlockModel: Model<Block>;
  let ContactModel: Model<Contact>;
  let service: UserServiceType;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    BlockModel = connection.model(Block.name, BlockSchema);
    ContactModel = connection.model(Contact.name, ContactSchema);

    const fakePresence = {
      isOnline: jest.fn().mockResolvedValue(false),
    } as unknown as PresenceService;
    const fakeTokenCache = {
      invalidate: jest.fn(),
    } as unknown as TokenCacheService;

    const fakePacks = {
      describeUsableItem: jest.fn((itemId: string) => {
        if (itemId === "507f1f77bcf86cd7994390aa") {
          return Promise.resolve({
            packId: "p1",
            packType: "emoji",
            keywords: ["fire", "🔥"],
            relativePath: "h/original.webp",
            thumbPath: "h/pack-thumb.webp",
            stillPath: "h/pack-still.webp",
            animated: true,
          });
        }
        if (itemId === "507f1f77bcf86cd7994390bb") {
          return Promise.resolve({
            packId: "p2",
            packType: "sticker",
            keywords: [],
            relativePath: "s/original.webp",
            thumbPath: "",
            stillPath: "",
            animated: false,
          });
        }
        return Promise.reject(new Error("Add this pack before using it"));
      }),
    } as unknown as PacksService;

    const { UserService } = await import("./user.service");
    service = new UserService(
      UserModel,
      BlockModel,
      ContactModel,
      fakePresence,
      fakeTokenCache,
      fakePacks,
      privacyServiceFor(connection),
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all([UserModel.deleteMany({}), ContactModel.deleteMany({})]);
  });

  async function makeUser(overrides: Partial<User> = {}) {
    return UserModel.create({
      username: `u${Date.now()}${Math.random()}`.replace(".", ""),
      email: `${Date.now()}${Math.random()}@example.com`.replace(".", ""),
      password: "hashed",
      phoneNumber: "+15550001111",
      ...overrides,
    });
  }

  describe("findOne / findByUsername (profile page)", () => {
    it("never reveals phone/email to a stranger", async () => {
      const target = await makeUser({ username: "targetuser" });
      const viewer = await makeUser();

      const byId = await service.findOne(
        target._id.toString(),
        viewer._id.toString(),
      );
      expect(byId.phoneNumber).toBeUndefined();
      expect(byId.email).toBeUndefined();

      const byUsername = await service.findByUsername(
        "targetuser",
        viewer._id.toString(),
      );
      expect(byUsername.phoneNumber).toBeUndefined();
      expect(byUsername.email).toBeUndefined();
    });

    it("reveals the phone (default: my contacts) once the target saved the viewer; email stays hidden (default: nobody)", async () => {
      const target = await makeUser({
        username: "mutualtarget",
        phoneNumber: "+15551110000",
        email: "mutual@example.com",
      });
      const viewer = await makeUser();
      await ContactModel.create({
        ownerId: viewer._id.toString(),
        userId: target._id.toString(),
      });
      await ContactModel.create({
        ownerId: target._id.toString(),
        userId: viewer._id.toString(),
      });

      const profile = await service.findOne(
        target._id.toString(),
        viewer._id.toString(),
      );
      expect(profile.phoneNumber).toBe("+15551110000");
      expect(profile.email).toBeUndefined();
      expect(profile.canCall).toBe(true);
      expect(profile.canAddToGroups).toBe(true);
    });

    it("reveals your own contact info when viewing your own profile", async () => {
      const me = await makeUser({ username: "self" });
      const profile = await service.findOne(
        me._id.toString(),
        me._id.toString(),
      );
      expect(profile.phoneNumber).toBe("+15550001111");
    });

    it("omits phone/email entirely with no viewerId (unauthenticated-shaped call)", async () => {
      const target = await makeUser();
      const profile = await service.findOne(target._id.toString());
      expect(profile.phoneNumber).toBeUndefined();
      expect(profile.email).toBeUndefined();
    });
  });

  describe("updateQuickReaction", () => {
    it("sets a plain emoji and clears an animated one", async () => {
      const u = await makeUser();
      await service.updateQuickReaction(
        u._id.toString(),
        undefined,
        "507f1f77bcf86cd7994390aa",
      );
      await service.updateQuickReaction(u._id.toString(), "😂");
      const after = await UserModel.findById(u._id).lean();
      expect(after?.quickReaction).toBe("😂");
      expect(after?.quickReactionItem).toBeNull();
    });

    it("stores an animated emoji with its emoji keyword as the fallback", async () => {
      const u = await makeUser();
      await service.updateQuickReaction(
        u._id.toString(),
        undefined,
        "507f1f77bcf86cd7994390aa",
      );
      const after = await UserModel.findById(u._id).lean();
      expect(after?.quickReaction).toBe("🔥");
      expect(after?.quickReactionItem).toMatchObject({
        packItemId: "507f1f77bcf86cd7994390aa",
        packId: "p1",
        thumbPath: "h/pack-thumb.webp",
      });
    });

    it("rejects a sticker, an unadded pack, both or neither", async () => {
      const id = (await makeUser())._id.toString();
      await expect(
        service.updateQuickReaction(id, undefined, "507f1f77bcf86cd7994390bb"),
      ).rejects.toThrow(/only animated emoji/i);
      await expect(
        service.updateQuickReaction(id, undefined, "507f1f77bcf86cd7994390cc"),
      ).rejects.toThrow(/add this pack/i);
      await expect(
        service.updateQuickReaction(id, "👍", "507f1f77bcf86cd7994390aa"),
      ).rejects.toThrow(/not both/i);
      await expect(service.updateQuickReaction(id)).rejects.toThrow(
        /required/i,
      );
    });
  });
});
