import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { NotFoundException } from "@nestjs/common";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Session, SessionSchema } from "src/auth/schema/session.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Report, ReportSchema } from "src/moderation/schema/report.schema";
import {
  ModerationLog,
  ModerationLogSchema,
} from "src/moderation/schema/moderation-log.schema";
import { ModerationLogService } from "src/moderation/moderation-log.service";
import { ChatType, UserRole } from "src/enum/base.enum";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import {
  AdminUser,
  AdminUserSchema,
  AdminRole,
} from "./schema/admin-user.schema";
import { AdminAuditService } from "./admin-audit.service";
import { AdminUsersService } from "./admin-users.service";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const FUTURE = new Date("2026-07-01T00:00:00.000Z");

describe("AdminUsersService + AdminAuditService (D1: directory, detail, audit)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let SessionModel: Model<Session>;
  let ChatModel: Model<Chat>;
  let ChatMembersModel: Model<ChatMembers>;
  let ReportModel: Model<Report>;
  let LogModel: Model<ModerationLog>;
  let AdminModel: Model<AdminUser>;
  let MessageModel: Model<Message>;
  let users: AdminUsersService;
  let audit: AdminAuditService;

  let alice: Types.ObjectId;
  let bob: Types.ObjectId;

  let dana: Types.ObjectId;
  let adminId: Types.ObjectId;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    MessageModel = connection.model(Message.name, MessageSchema);
    UserModel = connection.model(User.name, UserSchema);
    SessionModel = connection.model(Session.name, SessionSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    ReportModel = connection.model(Report.name, ReportSchema);
    LogModel = connection.model(ModerationLog.name, ModerationLogSchema);
    AdminModel = connection.model(AdminUser.name, AdminUserSchema);

    const admin = await AdminModel.create({
      email: "support@example.com",
      passwordHash: "x",
      role: AdminRole.SUPPORT,
      mfaSecret: "x",
    });
    adminId = admin._id;

    alice = (
      await UserModel.create({
        username: "alice",
        email: "alice@example.com",
        password: "x",
        firstName: "Alice",
        createdAt: new Date("2026-01-01"),
      })
    )._id;
    bob = (
      await UserModel.create({
        username: "bobby",
        email: "bob@example.com",
        password: "x",
        firstName: "Bob",
        suspendedUntil: FUTURE,
        createdAt: new Date("2026-02-01"),
      })
    )._id;
    await UserModel.create({
      username: "carol",
      email: "carol@example.com",
      password: "x",
      isDeleted: true,
      createdAt: new Date("2026-03-01"),
    });
    dana = (
      await UserModel.create({
        username: "dana",
        email: "dana@example.com",
        password: "x",
        firstName: "Dana",
        phoneNumber: "+15550001",
        createdAt: new Date("2026-04-01"),
      })
    )._id;

    const services = new AdminUsersService(
      UserModel,
      SessionModel,
      ChatModel,
      ChatMembersModel,
      ReportModel,
      MessageModel,
      new ModerationLogService(LogModel),
      new AdminAuditService(LogModel, AdminModel),
    );
    users = services;
    audit = new AdminAuditService(LogModel, AdminModel);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  describe("directory", () => {
    it("lists every user, newest first, with a derived status", async () => {
      const { items, total } = await users.list({
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(total).toBe(4);
      expect(items.map(u => u.username)).toEqual([
        "dana",
        "carol",
        "bobby",
        "alice",
      ]);
      expect(items.find(u => u.username === "bobby")?.status).toBe("suspended");
      expect(items.find(u => u.username === "carol")?.status).toBe("deleted");
      expect(items.find(u => u.username === "alice")?.status).toBe("active");
    });

    it("filters by status", async () => {
      const active = await users.list({
        status: "active",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(active.items.map(u => u.username).sort()).toEqual([
        "alice",
        "dana",
      ]);

      const suspended = await users.list({
        status: "suspended",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(suspended.items.map(u => u.username)).toEqual(["bobby"]);

      const deleted = await users.list({
        status: "deleted",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(deleted.items.map(u => u.username)).toEqual(["carol"]);
    });

    it("treats an expired suspension as active", async () => {
      const later = new Date("2026-08-01T00:00:00.000Z");
      const active = await users.list({
        status: "active",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: later,
      });
      expect(active.items.map(u => u.username)).toContain("bobby");
    });

    it("searches username, email, phone and name case-insensitively", async () => {
      const byName = await users.list({
        q: "BOB",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(byName.items.map(u => u.username)).toEqual(["bobby"]);

      const byEmail = await users.list({
        q: "carol@",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(byEmail.items.map(u => u.username)).toEqual(["carol"]);

      const byPhone = await users.list({
        q: "+1555",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(byPhone.items.map(u => u.username)).toEqual(["dana"]);

      const byFirstName = await users.list({
        q: "dana",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(byFirstName.items.map(u => u.username)).toEqual(["dana"]);
    });

    it("matches only at the start of a word, not in the middle", async () => {
      const { total } = await users.list({
        q: "ice",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(total).toBe(0);
    });

    it("redacts contact details and IPs for moderators only", async () => {
      const mod = await users.list({
        q: "bo",
        limit: 50,
        offset: 0,
        viewerRole: "moderator",
        now: NOW,
      });
      expect(mod.items[0].email).toBe("b***@example.com");
      const support = await users.list({
        q: "bo",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(support.items[0].email).toBe("bob@example.com");

      await SessionModel.create({
        userId: dana,
        refreshTokenHash: "hash-redact",
        familyId: "fam-r",
        ip: "198.51.100.7",
      });
      const detail = await users.detail(
        String(adminId),
        String(dana),
        "moderator",
        NOW,
      );
      expect(detail.profile.phoneNumber).toBe("***01");
      expect(detail.sessions[0].ip).toBe("198.51.x.x");
      expect(detail.sessions[0].ip).not.toContain("7");
    });

    it("treats the search text literally, not as a regex", async () => {
      const { total } = await users.list({
        q: ".*",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(total).toBe(0);
    });

    it("combines search and status", async () => {
      const { items } = await users.list({
        q: "al",
        status: "active",
        limit: 50,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      expect(items.map(u => u.username)).toEqual(["alice"]);
    });

    it("paginates, with the total reflecting the whole set", async () => {
      const page1 = await users.list({
        limit: 2,
        offset: 0,
        viewerRole: "support",
        now: NOW,
      });
      const page2 = await users.list({
        limit: 2,
        offset: 2,
        viewerRole: "support",
        now: NOW,
      });
      expect(page1.total).toBe(4);
      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(2);
      const seen = [...page1.items, ...page2.items].map(u => u.username);
      expect(new Set(seen).size).toBe(4);
    });
  });

  describe("detail", () => {
    it("throws NotFound and writes no audit entry for an unknown user", async () => {
      const before = await LogModel.countDocuments({ action: "user.view" });
      await expect(
        users.detail(
          String(adminId),
          String(new Types.ObjectId()),
          "support",
          NOW,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(await LogModel.countDocuments({ action: "user.view" })).toBe(
        before,
      );
    });

    it("returns the profile, memberships, sessions and reports, and writes a user.view entry", async () => {
      const chat = await ChatModel.create({
        name: "Team",
        type: ChatType.GROUP,
      });
      await ChatMembersModel.create({
        channelId: String(chat._id),
        userId: String(bob),
        role: UserRole.MEMBER,
        isJoined: true,
      });
      await SessionModel.create({
        userId: bob,
        refreshTokenHash: "hash-1",
        familyId: "fam-1",
        device: "Pixel",
        ip: "203.0.113.5",
      });
      await ReportModel.create({
        reporterId: alice,
        targetType: "user",
        targetId: String(bob),
        reason: "spam",
      });

      const detail = await users.detail(
        String(adminId),
        String(bob),
        "support",
        NOW,
      );

      expect(detail.profile.username).toBe("bobby");
      expect(detail.profile.status).toBe("suspended");
      expect(detail.memberships.map(m => m.name)).toEqual(["Team"]);
      expect(detail.memberships[0].role).toBe(UserRole.MEMBER);
      expect(detail.sessions).toHaveLength(1);
      expect(detail.sessions[0].device).toBe("Pixel");
      expect(detail.sessions[0]).not.toHaveProperty("refreshTokenHash");
      expect(detail.reports).toHaveLength(1);
      expect(detail.reports[0].role).toBe("target");

      const viewed = detail.history.find(h => h.action === "user.view");
      expect(viewed).toBeDefined();
      expect(viewed?.actor?.email).toBe("support@example.com");
      expect(viewed?.targetId).toBe(String(bob));
    });

    it("marks a report the user filed as reporter, not target", async () => {
      const detail = await users.detail(
        String(adminId),
        String(alice),
        "support",
        NOW,
      );
      expect(detail.reports).toHaveLength(1);
      expect(detail.reports[0].role).toBe("reporter");
    });

    it("shows reports about the user's messages and moderation actions that name the user", async () => {
      const msg = await MessageModel.create({
        channelId: String(new Types.ObjectId()),
        senderId: bob,
        content: "hello",
      });
      await ReportModel.create({
        reporterId: dana,
        targetType: "message",
        targetId: String(msg._id),
        reason: "abuse",
      });
      await LogModel.create({
        actorId: adminId,
        action: "message.hard_hide",
        targetType: "message",
        targetId: String(msg._id),
        at: new Date(),
      });
      await LogModel.create({
        actorId: adminId,
        action: "channel.remove_member",
        targetType: "channel",
        targetId: String(new Types.ObjectId()),
        meta: { userId: String(bob) },
        at: new Date(),
      });

      const detail = await users.detail(
        String(adminId),
        String(bob),
        "support",
        NOW,
      );
      const messageReport = detail.reports.find(
        r => r.targetId === String(msg._id),
      );
      expect(messageReport?.role).toBe("message");
      const actions = detail.history.map(h => h.action);
      expect(actions).toEqual(
        expect.arrayContaining(["message.hard_hide", "channel.remove_member"]),
      );
    });

    it("skips memberships whose chat no longer exists", async () => {
      await ChatMembersModel.create({
        channelId: String(new Types.ObjectId()),
        userId: String(dana),
        role: UserRole.MEMBER,
        isJoined: true,
      });
      const detail = await users.detail(
        String(adminId),
        String(dana),
        "support",
        NOW,
      );
      expect(detail.memberships).toHaveLength(0);
    });
  });

  describe("audit viewer", () => {
    beforeAll(async () => {
      await LogModel.create({
        actorId: adminId,
        action: "user.suspend",
        targetType: "user",
        targetId: String(alice),
        at: new Date("2026-05-10T00:00:00.000Z"),
      });
    });

    it("filters by action and target", async () => {
      const { items } = await audit.list({
        action: "user.suspend",
        targetId: String(alice),
        limit: 50,
        offset: 0,
      });
      expect(items).toHaveLength(1);
      expect(items[0].actor?.email).toBe("support@example.com");
      expect(items[0].actor?.role).toBe(AdminRole.SUPPORT);
    });

    it("filters by actor", async () => {
      const { total } = await audit.list({
        actorId: String(adminId),
        limit: 50,
        offset: 0,
      });
      expect(total).toBeGreaterThan(0);
      const { total: none } = await audit.list({
        actorId: String(new Types.ObjectId()),
        limit: 50,
        offset: 0,
      });
      expect(none).toBe(0);
    });

    it("filters by date range, inclusive", async () => {
      const { items } = await audit.list({
        from: new Date("2026-05-01T00:00:00.000Z"),
        to: new Date("2026-05-31T23:59:59.000Z"),
        limit: 50,
        offset: 0,
      });
      expect(items.map(i => i.action)).toEqual(["user.suspend"]);
    });

    it("returns newest first", async () => {
      const { items } = await audit.list({ limit: 50, offset: 0 });
      const times = items.map(i => i.at.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });
  });
});
