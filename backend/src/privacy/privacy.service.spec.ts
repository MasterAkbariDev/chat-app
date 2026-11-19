import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Contact, ContactSchema } from "src/contacts/schema/contact.schema";
import {
  PRIVACY_DEFAULTS,
  lastSeenBucket,
  privacyOf,
  privacyRulesOf,
  ruleAllows,
  type PrivacyRule,
} from "src/user/schema/privacy";
import { toMeDto } from "src/common/dto/user-view.dto";
import { QueryCounter } from "src/common/testing/query-counter";
import { PrivacyService } from "./privacy.service";

const rule = (r: Partial<PrivacyRule> = {}): PrivacyRule => ({
  audience: "everybody",
  allow: [],
  deny: [],
  ...r,
});

describe("privacy rules (pure)", () => {
  const owner = "o";
  const viewer = "v";

  it("the owner always sees their own data", () => {
    expect(
      ruleAllows(
        rule({ audience: "nobody", deny: [owner] }),
        owner,
        owner,
        false,
      ),
    ).toBe(true);
  });

  it("audiences: everybody / contacts (= people the OWNER saved) / nobody", () => {
    expect(ruleAllows(rule(), owner, viewer, false)).toBe(true);
    expect(
      ruleAllows(rule({ audience: "contacts" }), owner, viewer, false),
    ).toBe(false);
    expect(
      ruleAllows(rule({ audience: "contacts" }), owner, viewer, true),
    ).toBe(true);
    expect(ruleAllows(rule({ audience: "nobody" }), owner, viewer, true)).toBe(
      false,
    );
  });

  it("'always allow' overrides contacts/nobody; 'never allow' overrides everything", () => {
    expect(
      ruleAllows(
        rule({ audience: "nobody", allow: [viewer] }),
        owner,
        viewer,
        false,
      ),
    ).toBe(true);
    expect(
      ruleAllows(
        rule({ audience: "contacts", allow: [viewer] }),
        owner,
        viewer,
        false,
      ),
    ).toBe(true);
    expect(ruleAllows(rule({ deny: [viewer] }), owner, viewer, true)).toBe(
      false,
    );
    expect(
      ruleAllows(
        rule({ audience: "contacts", deny: [viewer] }),
        owner,
        viewer,
        true,
      ),
    ).toBe(false);
    expect(
      ruleAllows(
        rule({ allow: [viewer], deny: [viewer] }),
        owner,
        viewer,
        true,
      ),
    ).toBe(false);
  });

  it("defaults: phone → contacts, email → nobody, everything else → everybody (discovery unchanged)", () => {
    const p = privacyOf({});
    expect(p).toEqual(PRIVACY_DEFAULTS);
    expect(p.phoneNumber).toBe("contacts");
    expect(p.email).toBe("nobody");
    for (const k of [
      "lastSeen",
      "profilePhotos",
      "bio",
      "calls",
      "groupInvites",
      "forwards",
      "findByUsername",
    ] as const) {
      expect(p[k]).toBe("everybody");
    }
    expect(p.findByPhoneOrEmail).toBe("contacts");
    // Garbage stored values fall back to the default, and exception lists default to empty.
    const r = privacyRulesOf({
      privacyRules: { bio: { audience: "weird", allow: "x" } },
    });
    expect(r.bio).toEqual({ audience: "everybody", allow: [], deny: [] });
  });

  it("last-seen approximations (Telegram's buckets)", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    const ago = (d: number) => new Date(now - d * 86_400_000);
    expect(lastSeenBucket(ago(100), true, now)).toBe("recently");
    expect(lastSeenBucket(ago(1), false, now)).toBe("recently");
    expect(lastSeenBucket(ago(5), false, now)).toBe("within_week");
    expect(lastSeenBucket(ago(20), false, now)).toBe("within_month");
    expect(lastSeenBucket(ago(45), false, now)).toBe("long_ago");
    expect(lastSeenBucket(null, false, now)).toBe("long_ago");
  });
});

describe("PrivacyService", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let ContactModel: Model<Contact>;
  let service: PrivacyService;
  let seq = 0;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    ContactModel = connection.model(Contact.name, ContactSchema);
    service = new PrivacyService(UserModel, ContactModel);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all([UserModel.deleteMany({}), ContactModel.deleteMany({})]);
  });

  const mk = (o: Partial<User> = {}) =>
    UserModel.create({
      username: `pv${++seq}x`,
      email: `pv${seq}@example.com`,
      password: "hashed",
      image: [`/uploads/media/p${seq}.jpg`],
      bio: `bio ${seq}`,
      ...o,
    });
  const id = (u: { _id: Types.ObjectId }) => u._id.toString();
  const save = (
    owner: { _id: Types.ObjectId },
    saved: { _id: Types.ObjectId },
  ) => ContactModel.create({ ownerId: id(owner), userId: id(saved) });

  describe("updateSettings / getSettings", () => {
    it("accepts a bare audience (old clients) and stores discovery audiences top-level", async () => {
      const me = await mk();
      const out = await service.updateSettings(id(me), {
        lastSeen: "nobody",
        findByUsername: "contacts",
      });
      expect(out.lastSeen.audience).toBe("nobody");
      expect(out.findByUsername.audience).toBe("contacts");
      const raw = await UserModel.findById(me._id).lean();
      expect(raw?.findByUsername).toBe("contacts");
      expect(raw?.privacyRules?.lastSeen?.audience).toBe("nobody");
      expect(toMeDto(raw!).privacy.lastSeen).toBe("nobody");
    });

    it("exception lists: resolved to people, self dropped, moving between lists, no overlap", async () => {
      const me = await mk();
      const a = await mk({ firstName: "Ali" });
      const b = await mk();
      let out = await service.updateSettings(id(me), {
        profilePhotos: {
          audience: "contacts",
          allow: [id(a), id(me), id(a)],
          deny: [id(b)],
        },
      });
      expect(out.profilePhotos.audience).toBe("contacts");
      expect(out.profilePhotos.allow.map(u => u._id)).toEqual([id(a)]);
      expect(out.profilePhotos.allow[0].firstName).toBe("Ali");
      expect(out.profilePhotos.deny.map(u => u._id)).toEqual([id(b)]);

      // Adding b to "always allow" takes them off "never allow".
      out = await service.updateSettings(id(me), {
        profilePhotos: { allow: [id(a), id(b)] },
      });
      expect(out.profilePhotos.allow.map(u => u._id).sort()).toEqual(
        [id(a), id(b)].sort(),
      );
      expect(out.profilePhotos.deny).toEqual([]);
      expect(out.profilePhotos.audience).toBe("contacts");

      await expect(
        service.updateSettings(id(me), {
          bio: { allow: [id(a)], deny: [id(a)] },
        }),
      ).rejects.toThrow(/both/);
      expect(
        (await service.getSettings(id(me))).profilePhotos.allow,
      ).toHaveLength(2);
    });

    it("rejects unknown keys and bad values", async () => {
      const me = await mk();
      await expect(
        service.updateSettings(id(me), { nope: "nobody" }),
      ).rejects.toThrow(/Unknown/);
      await expect(
        service.updateSettings(id(me), { bio: "friends" }),
      ).rejects.toThrow();
      await expect(
        service.updateSettings(id(me), { bio: { allow: ["zzz"] } }),
      ).rejects.toThrow();
      await expect(
        service.updateSettings(id(me), { bio: { color: "red" } }),
      ).rejects.toThrow();
    });
  });

  describe("forViewer (batched view of many people)", () => {
    it("loads any number of targets in exactly 2 queries", async () => {
      const viewer = await mk();
      const targets = await Promise.all([1, 2, 3, 4, 5, 6].map(() => mk()));
      await save(targets[0], viewer);
      const counter = new QueryCounter();
      counter.start();
      const view = await service.forViewer(
        id(viewer),
        targets.map(t => t._id),
      );
      const count = counter.stop();
      expect(count).toBe(2);
      expect(view.can(id(targets[0]), "phoneNumber")).toBe(true); // they saved me
      expect(view.can(id(targets[1]), "phoneNumber")).toBe(false);
    });

    it("publicUser hides photos (incl. video) and bio per rule and exceptions", async () => {
      const viewer = await mk();
      const friend = await mk();
      const t = await mk({ avatarVideo: "/uploads/media/v.mp4" });
      await service.updateSettings(id(t), {
        profilePhotos: { audience: "nobody", allow: [id(friend)] },
        bio: { audience: "everybody", deny: [id(viewer)] },
      });
      const raw = (await UserModel.findById(t._id).lean())!;
      const asViewer = (
        await service.forViewer(id(viewer), [t._id])
      ).publicUser(raw);
      expect(asViewer.avatarUrl).toEqual([]);
      expect(asViewer.avatarVideoUrl).toBeUndefined();
      expect(asViewer.bio).toBe("");
      expect(asViewer.firstName).toBe(raw.firstName); // names are never hidden
      const asFriend = (
        await service.forViewer(id(friend), [t._id])
      ).publicUser(raw);
      expect(asFriend.avatarUrl).toEqual(raw.image);
      expect(asFriend.avatarVideoUrl).toBe("/uploads/media/v.mp4");
      expect(asFriend.bio).toBe(raw.bio);
      const asSelf = (await service.forViewer(id(t), [t._id])).publicUser(raw);
      expect(asSelf.avatarUrl).toEqual(raw.image);
    });

    it("'contacts' means people the target saved — not people who saved the target", async () => {
      const viewer = await mk();
      const t = await mk();
      await service.updateSettings(id(t), { bio: "contacts" });
      await save(viewer, t); // viewer saved target: irrelevant
      expect(
        (await service.forViewer(id(viewer), [t._id])).can(id(t), "bio"),
      ).toBe(false);
      await save(t, viewer);
      expect(
        (await service.forViewer(id(viewer), [t._id])).can(id(t), "bio"),
      ).toBe(true);
    });
  });

  describe("last seen reciprocity", () => {
    it("hiding yours from someone hides theirs from you; exceptions restore it", async () => {
      const me = await mk();
      const other = await mk({
        lastSeen: new Date(Date.now() - 2 * 86_400_000),
      });
      // other shares with everybody; I hide mine from everybody.
      await service.updateSettings(id(me), { lastSeen: "nobody" });
      let view = await service.forViewer(id(me), [other._id]);
      expect(view.can(id(other), "lastSeen")).toBe(true);
      expect(view.canSeeLastSeen(id(other))).toBe(false);
      expect(view.presence(id(other), other.lastSeen, true)).toEqual({
        userId: id(other),
        isOnline: false,
        lastSeen: null,
        lastSeenBucket: "recently",
      });
      // and they can't see mine either
      const theirView = await service.forViewer(id(other), [me._id]);
      expect(theirView.canSeeLastSeen(id(me))).toBe(false);

      // Me: nobody, but always allow `other` → both see each other again.
      await service.updateSettings(id(me), {
        lastSeen: { allow: [id(other)] },
      });
      view = await service.forViewer(id(me), [other._id]);
      expect(view.canSeeLastSeen(id(other))).toBe(true);
      expect(view.presence(id(other), other.lastSeen, true)).toEqual({
        userId: id(other),
        isOnline: true,
        lastSeen: other.lastSeen,
      });
    });

    it("forTarget evaluates many viewers at once (presence fan-out)", async () => {
      const t = await mk();
      const [a, b, c, d] = await Promise.all([mk(), mk(), mk(), mk()]);
      await service.updateSettings(id(t), {
        lastSeen: { audience: "contacts", allow: [id(d)] },
      });
      await save(t, a); // a is a contact of t
      await save(t, b); // b too, but b hides their own last seen from everyone
      await service.updateSettings(id(b), { lastSeen: "nobody" });
      const counter = new QueryCounter();
      counter.start();
      const graph = await service.forTarget(id(t), [
        a._id,
        b._id,
        c._id,
        d._id,
      ]);
      expect(counter.stop()).toBe(2);
      expect(graph.lastSeenVisible(id(t), id(a))).toBe(true);
      expect(graph.lastSeenVisible(id(t), id(b))).toBe(false); // reciprocity
      expect(graph.lastSeenVisible(id(t), id(c))).toBe(false); // not a contact
      expect(graph.lastSeenVisible(id(t), id(d))).toBe(true); // exception
    });
  });

  describe("audienceOf (room broadcasts)", () => {
    it("is 'everyone' by default and splits per viewer otherwise; updates apply immediately", async () => {
      const t = await mk();
      const friend = await mk();
      const stranger = await mk();
      expect((await service.audienceOf(id(t), "profilePhotos")).everyone).toBe(
        true,
      );
      await save(t, friend);
      await service.updateSettings(id(t), { profilePhotos: "contacts" });
      const a = await service.audienceOf(id(t), "profilePhotos");
      expect(a.everyone).toBe(false);
      expect(a.allows(id(friend))).toBe(true);
      expect(a.allows(id(stranger))).toBe(false);
      // "everybody" with a "never allow" entry still needs the per-viewer split.
      await service.updateSettings(id(t), {
        profilePhotos: { audience: "everybody", deny: [id(stranger)] },
      });
      const b = await service.audienceOf(id(t), "profilePhotos");
      expect(b.everyone).toBe(false);
      expect(b.allows(id(friend))).toBe(true);
      expect(b.allows(id(stranger))).toBe(false);
    });
  });
});
