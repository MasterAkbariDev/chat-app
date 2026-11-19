import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { ModerationService } from "src/moderation/moderation.service";
import { ModerationLogService } from "src/moderation/moderation-log.service";
import { User } from "src/user/schema/user.schema";
import {
  SupportTicket,
  TicketStatus,
} from "src/support/schema/support-ticket.schema";
import { AdminUser } from "./schema/admin-user.schema";
import { UpdateTicketDto } from "./dto/ticket-admin.dto";

/**
 * Support staff's side of tickets (ADMIN_PANEL_PLAN D2): queue, thread, reply, assign, status and
 * links. A reply sends the user a short notice in their Moderation DM that points at the ticket.
 * The reply text itself stays in the ticket thread, so there is one copy.
 */
@Injectable()
export class AdminSupportService {
  constructor(
    @InjectModel(SupportTicket.name) private ticketModel: Model<SupportTicket>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(AdminUser.name) private adminUserModel: Model<AdminUser>,
    private moderation: ModerationService,
    private moderationLog: ModerationLogService,
  ) {}

  async list(params: {
    status?: TicketStatus;
    assignedTo?: string;
    limit: number;
    offset: number;
  }) {
    const filter: FilterQuery<SupportTicket> = {};
    if (params.status) {
      filter.status = params.status;
    }
    if (params.assignedTo) {
      filter.assignedTo = new Types.ObjectId(params.assignedTo);
    }
    const [rows, total] = await Promise.all([
      this.ticketModel
        .find(filter)
        .sort({ lastActivityAt: -1 })
        .skip(params.offset)
        .limit(params.limit)
        .lean()
        .exec(),
      this.ticketModel.countDocuments(filter).exec(),
    ]);
    const [users, admins] = await Promise.all([
      this.usersById(rows.map(r => r.userId)),
      this.adminsById(rows.map(r => r.assignedTo)),
    ]);
    return {
      total,
      items: rows.map(t => ({
        id: String(t._id),
        subject: t.subject,
        status: t.status,
        lastActivityAt: t.lastActivityAt,
        messageCount: t.messages.length,
        user: users.get(String(t.userId)) ?? null,
        assignedTo: t.assignedTo
          ? (admins.get(String(t.assignedTo)) ?? null)
          : null,
      })),
    };
  }

  async get(ticketId: string) {
    const t = await this.loadTicket(ticketId);
    const [users, admins] = await Promise.all([
      this.usersById([t.userId]),
      this.adminsById(t.assignedTo ? [t.assignedTo] : []),
    ]);
    return {
      id: String(t._id),
      subject: t.subject,
      status: t.status,
      lastActivityAt: t.lastActivityAt,
      createdAt: t.createdAt,
      user: users.get(String(t.userId)) ?? null,
      assignedTo: t.assignedTo
        ? (admins.get(String(t.assignedTo)) ?? null)
        : null,
      relatedRecoveryRequestId: t.relatedRecoveryRequestId
        ? String(t.relatedRecoveryRequestId)
        : null,
      relatedReportId: t.relatedReportId ? String(t.relatedReportId) : null,
      messages: t.messages.map(m => ({
        author: m.author,
        body: m.body,
        at: m.at,
      })),
    };
  }

  async reply(ticketId: string, adminId: string, body: string) {
    const t = await this.loadTicket(ticketId);
    const now = new Date();
    await this.ticketModel
      .updateOne(
        { _id: t._id },
        {
          $push: {
            messages: {
              author: "admin",
              authorId: new Types.ObjectId(adminId),
              body,
              at: now,
            },
          },
          $set: { status: TicketStatus.PENDING, lastActivityAt: now },
        },
      )
      .exec();

    await this.moderation.deliverSystemDm(
      String(t.userId),
      `Support replied to your ticket "${t.subject}". Open Support in the app to read it.`,
    );
    await this.moderationLog.log(adminId, "ticket.reply", "ticket", ticketId, {
      userId: String(t.userId),
    });
    return { success: true };
  }

  async update(ticketId: string, adminId: string, dto: UpdateTicketDto) {
    const t = await this.loadTicket(ticketId);
    const $set: Record<string, unknown> = {};
    const meta: Record<string, unknown> = {};

    if (dto.status !== undefined) {
      $set.status = dto.status;
      meta.status = dto.status;
    }
    if (dto.assignedTo !== undefined) {
      if (dto.assignedTo !== null) {
        const exists = await this.adminUserModel.exists({
          _id: dto.assignedTo,
          isDisabled: false,
        });
        if (!exists) {
          throw new BadRequestException("Assignee is not an active admin");
        }
      }
      $set.assignedTo =
        dto.assignedTo === null ? null : new Types.ObjectId(dto.assignedTo);
      meta.assignedTo = dto.assignedTo;
    }
    if (dto.relatedRecoveryRequestId !== undefined) {
      $set.relatedRecoveryRequestId =
        dto.relatedRecoveryRequestId === null
          ? null
          : new Types.ObjectId(dto.relatedRecoveryRequestId);
      meta.relatedRecoveryRequestId = dto.relatedRecoveryRequestId;
    }
    if (dto.relatedReportId !== undefined) {
      $set.relatedReportId =
        dto.relatedReportId === null
          ? null
          : new Types.ObjectId(dto.relatedReportId);
      meta.relatedReportId = dto.relatedReportId;
    }

    if (Object.keys($set).length === 0) {
      throw new BadRequestException("Nothing to change");
    }
    await this.ticketModel.updateOne({ _id: t._id }, { $set }).exec();
    await this.moderationLog.log(
      adminId,
      "ticket.update",
      "ticket",
      ticketId,
      meta,
    );
    return { success: true };
  }

  private async loadTicket(ticketId: string) {
    if (!Types.ObjectId.isValid(ticketId)) {
      throw new BadRequestException('"id" must be a valid id');
    }
    const t = await this.ticketModel.findById(ticketId).lean().exec();
    if (!t) {
      throw new NotFoundException("Ticket not found");
    }
    return t;
  }

  private async usersById(ids: Types.ObjectId[]) {
    const rows = await this.userModel
      .find({ _id: { $in: ids } })
      .select("username firstName lastName email")
      .lean()
      .exec();
    return new Map(
      rows.map(u => [
        String(u._id),
        {
          id: String(u._id),
          username: u.username ?? "",
          firstName: u.firstName ?? "",
          lastName: u.lastName ?? "",
          email: u.email ?? "",
        },
      ]),
    );
  }

  private async adminsById(ids: Array<Types.ObjectId | null>) {
    const present = ids.filter((id): id is Types.ObjectId => id !== null);
    const rows = await this.adminUserModel
      .find({ _id: { $in: present } })
      .select("email role")
      .lean()
      .exec();
    return new Map(
      rows.map(a => [
        String(a._id),
        { id: String(a._id), email: a.email, role: a.role },
      ]),
    );
  }
}
