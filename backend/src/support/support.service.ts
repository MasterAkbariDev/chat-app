import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { SupportTicket, TicketStatus } from "./schema/support-ticket.schema";

/** The user's side of support tickets: open one, read them, reply. Only their own tickets. */
@Injectable()
export class SupportService {
  constructor(
    @InjectModel(SupportTicket.name)
    private ticketModel: Model<SupportTicket>,
  ) {}

  async create(userId: string, subject: string, body: string) {
    const now = new Date();
    const ticket = await this.ticketModel.create({
      userId: new Types.ObjectId(userId),
      subject: subject.trim(),
      status: TicketStatus.OPEN,
      messages: [
        { author: "user", authorId: new Types.ObjectId(userId), body, at: now },
      ],
      lastActivityAt: now,
    });
    return present(ticket.toObject());
  }

  async listMine(userId: string) {
    const rows = await this.ticketModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ lastActivityAt: -1 })
      .limit(100)
      .lean()
      .exec();
    return rows.map(present);
  }

  async getMine(userId: string, ticketId: string) {
    const ticket = await this.ticketModel
      .findOne({ _id: ticketId, userId: new Types.ObjectId(userId) })
      .lean()
      .exec();
    if (!ticket) {
      throw new NotFoundException("Ticket not found");
    }
    return present(ticket);
  }

  /** A user reply. Reopens the ticket if support had closed or was waiting on them. */
  async reply(userId: string, ticketId: string, body: string) {
    const now = new Date();
    const ticket = await this.ticketModel
      .findOneAndUpdate(
        { _id: ticketId, userId: new Types.ObjectId(userId) },
        {
          $push: {
            messages: {
              author: "user",
              authorId: new Types.ObjectId(userId),
              body,
              at: now,
            },
          },
          $set: { status: TicketStatus.OPEN, lastActivityAt: now },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!ticket) {
      throw new NotFoundException("Ticket not found");
    }
    return present(ticket);
  }
}

/** The shape both sides see. Internal fields (assignment, links) are left to the admin view. */
export function present(t: {
  _id: Types.ObjectId;
  subject: string;
  status: string;
  messages: Array<{ author: string; body: string; at: Date }>;
  lastActivityAt: Date;
  createdAt?: Date;
}) {
  return {
    id: String(t._id),
    subject: t.subject,
    status: t.status,
    lastActivityAt: t.lastActivityAt,
    createdAt: t.createdAt,
    messages: t.messages.map(m => ({
      author: m.author,
      body: m.body,
      at: m.at,
    })),
  };
}
