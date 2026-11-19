import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { User, UserSchema } from "src/user/schema/user.schema";
import {
  SupportTicket,
  SupportTicketSchema,
  TicketStatus,
} from "src/support/schema/support-ticket.schema";
import {
  ModerationLog,
  ModerationLogSchema,
} from "src/moderation/schema/moderation-log.schema";
import { ModerationLogService } from "src/moderation/moderation-log.service";
import type { ModerationService } from "src/moderation/moderation.service";
import {
  AdminUser,
  AdminUserSchema,
  AdminRole,
} from "./schema/admin-user.schema";
import type { AdminSupportService as AdminSupportServiceType } from "./admin-support.service";

// Loaded lazily: see the CORS note in beforeAll.
function loadService(): typeof AdminSupportServiceType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("./admin-support.service") as {
    AdminSupportService: typeof AdminSupportServiceType;
  };
  return mod.AdminSupportService;
}

describe("AdminSupportService (support staff side of tickets)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let TicketModel: Model<SupportTicket>;
  let AdminModel: Model<AdminUser>;
  let LogModel: Model<ModerationLog>;
  let support: AdminSupportServiceType;
  let AdminSupportService: typeof AdminSupportServiceType;
  let deliverSystemDm: jest.Mock;
  let adminId: string;
  let otherAdminId: string;
  let userId: Types.ObjectId;
  let ticketId: string;

  beforeAll(async () => {
    // The service's module loads the chat gateway, which reads CORS_ORIGIN at import time.
    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";

    AdminSupportService = loadService();
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    TicketModel = connection.model(SupportTicket.name, SupportTicketSchema);
    AdminModel = connection.model(AdminUser.name, AdminUserSchema);
    LogModel = connection.model(ModerationLog.name, ModerationLogSchema);

    deliverSystemDm = jest.fn().mockResolvedValue(undefined);
    support = new AdminSupportService(
      TicketModel,
      UserModel,
      AdminModel,
      { deliverSystemDm } as unknown as ModerationService,
      new ModerationLogService(LogModel),
    );

    adminId = String(
      (
        await AdminModel.create({
          email: "sam@example.com",
          passwordHash: "x",
          role: AdminRole.SUPPORT,
          mfaSecret: "x",
        })
      )._id,
    );
    otherAdminId = String(
      (
        await AdminModel.create({
          email: "lee@example.com",
          passwordHash: "x",
          role: AdminRole.SUPPORT,
          mfaSecret: "x",
        })
      )._id,
    );
    userId = (
      await UserModel.create({
        username: "nora",
        email: "nora@example.com",
        password: "x",
        firstName: "Nora",
      })
    )._id;
    const t = await TicketModel.create({
      userId,
      subject: "Locked out",
      messages: [
        { author: "user", authorId: userId, body: "help", at: new Date() },
      ],
    });
    ticketId = String(t._id);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  it("the queue shows the user and the assignee, filterable by status and assignee", async () => {
    const all = await support.list({ limit: 50, offset: 0 });
    expect(all.total).toBe(1);
    expect(all.items[0].user?.username).toBe("nora");
    expect(all.items[0].assignedTo).toBeNull();

    await support.update(ticketId, adminId, { assignedTo: adminId });
    const mine = await support.list({
      assignedTo: adminId,
      limit: 50,
      offset: 0,
    });
    expect(mine.total).toBe(1);
    const theirs = await support.list({
      assignedTo: otherAdminId,
      limit: 50,
      offset: 0,
    });
    expect(theirs.total).toBe(0);
  });

  it("a reply appends an admin message, moves the ticket to pending, and sends a notice (not the text)", async () => {
    await expect(
      support.reply(ticketId, adminId, "Try resetting your password"),
    ).resolves.toEqual({ success: true });

    const t = await support.get(ticketId);
    expect(t.status).toBe(TicketStatus.PENDING);
    expect(t.messages.map(m => m.author)).toEqual(["user", "admin"]);
    expect(deliverSystemDm).toHaveBeenCalledWith(
      String(userId),
      expect.stringContaining('Support replied to your ticket "Locked out"'),
    );
    expect(
      (deliverSystemDm.mock.calls[0] as [string, string])[1],
    ).not.toContain("resetting");
    expect(
      await LogModel.countDocuments({
        action: "ticket.reply",
        targetId: ticketId,
      }),
    ).toBe(1);
  });

  it("status, assignee and links are updated and each change is audited", async () => {
    await support.update(ticketId, adminId, {
      status: TicketStatus.RESOLVED,
      assignedTo: null,
    });
    const t = await support.get(ticketId);
    expect(t.status).toBe(TicketStatus.RESOLVED);
    expect(t.assignedTo).toBeNull();

    const log = await LogModel.findOne({
      action: "ticket.update",
      targetId: ticketId,
    })
      .sort({ at: -1 })
      .lean();
    expect(log?.meta).toEqual(
      expect.objectContaining({
        status: TicketStatus.RESOLVED,
        assignedTo: null,
      }),
    );
  });

  it("refuses an assignee who is not an active admin, and an empty update", async () => {
    const ghost = String(new Types.ObjectId());
    await expect(
      support.update(ticketId, adminId, { assignedTo: ghost }),
    ).rejects.toThrow(BadRequestException);
    await expect(support.update(ticketId, adminId, {})).rejects.toThrow(
      /Nothing to change/,
    );
  });

  it("unknown tickets are 404", async () => {
    await expect(support.get(String(new Types.ObjectId()))).rejects.toThrow(
      NotFoundException,
    );
  });
});
