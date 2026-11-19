import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { NotFoundException } from "@nestjs/common";
import {
  SupportTicket,
  SupportTicketSchema,
  TicketStatus,
} from "./schema/support-ticket.schema";
import { SupportService } from "./support.service";

describe("SupportService (user side of tickets)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let TicketModel: Model<SupportTicket>;
  let support: SupportService;
  const alice = String(new Types.ObjectId());
  const bob = String(new Types.ObjectId());

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    TicketModel = connection.model(SupportTicket.name, SupportTicketSchema);
    support = new SupportService(TicketModel);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  it("opens a ticket with the first message and lists it for its owner", async () => {
    const t = await support.create(alice, "  Can't sign in ", "I get an error");
    expect(t.subject).toBe("Can't sign in");
    expect(t.status).toBe(TicketStatus.OPEN);
    expect(t.messages).toEqual([
      expect.objectContaining({ author: "user", body: "I get an error" }),
    ]);

    const mine = await support.listMine(alice);
    expect(mine.map(x => x.id)).toEqual([t.id]);
  });

  it("another user cannot read or reply to a ticket that is not theirs", async () => {
    const t = await support.create(alice, "Private", "secret");
    await expect(support.getMine(bob, t.id)).rejects.toThrow(NotFoundException);
    await expect(support.reply(bob, t.id, "hi")).rejects.toThrow(
      NotFoundException,
    );
    expect(await support.listMine(bob)).toEqual([]);
  });

  it("a user reply reopens a ticket that support had marked pending or resolved", async () => {
    const t = await support.create(alice, "Reopen me", "first");
    await TicketModel.updateOne(
      { _id: t.id },
      { $set: { status: TicketStatus.PENDING } },
    ).exec();

    const after = await support.reply(alice, t.id, "still broken");
    expect(after.status).toBe(TicketStatus.OPEN);
    expect(after.messages.map(m => m.body)).toEqual(["first", "still broken"]);
  });
});
