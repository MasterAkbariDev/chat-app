import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Contact } from "./schema/contact.schema";
import { User } from "src/user/schema/user.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { ChatState } from "src/chat/schema/chat-state.schema";
import { AddContactDto } from "./dto/add-contact.dto";
import { ContactSummaryDto } from "./dto/contact-summary.dto";
import { toPublicUserDto } from "src/common/dto/user-view.dto";
import { PresenceService } from "src/presence/presence.service";
import { ChatType } from "src/enum/base.enum";
import { privateChatLink } from "src/chat/private-chat-link.util";
import { PeopleDiscoveryService } from "src/user/people-discovery.service";
import { PrivacyService } from "src/privacy/privacy.service";

@Injectable()
export class ContactsService {
  constructor(
    @InjectModel(Contact.name) private readonly contactModel: Model<Contact>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Chat.name) private readonly chatModel: Model<Chat>,
    @InjectModel(ChatState.name)
    private readonly chatStateModel: Model<ChatState>,
    private readonly presenceService: PresenceService,
    private readonly discovery: PeopleDiscoveryService,
    private readonly privacy: PrivacyService,
  ) {}

  /**
   * `userId` (the "Add contact" button — the caller already knows exactly who) resolves
   * directly, no lookup ambiguity possible. Otherwise exact match only on whichever one of
   * username/phone/email was given — no fuzzy matching, so this can't be used to enumerate
   * accounts by partial info.
   */
  private async resolveUser(
    ownerId: string,
    dto: AddContactDto,
  ): Promise<User> {
    const provided = [dto.userId, dto.username, dto.phone, dto.email].filter(
      v => v !== undefined && v !== null && v !== "",
    );
    if (provided.length !== 1) {
      throw new BadRequestException(
        "Provide exactly one of userId, username, phone, or email",
      );
    }

    if (dto.userId) {
      if (!Types.ObjectId.isValid(dto.userId)) {
        throw new NotFoundException("No user found with that identifier");
      }
      const user = await this.userModel
        .findOne({ _id: dto.userId, isDeleted: false })
        .exec();
      if (!user) {
        throw new NotFoundException("No user found with that identifier");
      }
      return user;
    }

    // Exact match only, and only if the person's privacy settings let this caller find
    // them (findByUsername / findByPhoneOrEmail) and neither has blocked the other. A
    // hidden account gets exactly the same 404 as one that doesn't exist.
    const id = await this.discovery.resolveExact(
      ownerId,
      dto.username
        ? { username: dto.username }
        : dto.phone
          ? { phone: dto.phone }
          : { email: dto.email! },
    );
    const user = id
      ? await this.userModel.findOne({ _id: id, isDeleted: false }).exec()
      : null;
    if (!user) {
      throw new NotFoundException("No user found with that identifier");
    }
    return user;
  }

  async addContact(
    ownerId: string,
    dto: AddContactDto,
  ): Promise<{ _id: string }> {
    const user = await this.resolveUser(ownerId, dto);
    const userId = user._id.toString();
    if (userId === ownerId) {
      throw new BadRequestException("You can't add yourself as a contact");
    }

    const existing = await this.contactModel
      .findOne({ ownerId, userId })
      .exec();
    if (existing) {
      throw new ConflictException("Already in your contacts");
    }

    const created = await this.contactModel.create({
      ownerId,
      userId,
      customName: dto.customName ?? null,
    });
    return { _id: created._id.toString() };
  }

  async listContacts(ownerId: string): Promise<ContactSummaryDto[]> {
    const contacts = await this.contactModel
      .find({ ownerId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    if (!contacts.length) return [];

    const userIds = contacts.map(c => c.userId);
    const users = await this.userModel
      .find({ _id: { $in: userIds }, isDeleted: false })
      .select("username firstName lastName image avatarVideo bio")
      .lean()
      .exec();
    const userById = new Map(users.map(u => [String(u._id), u]));
    const view = await this.privacy.forViewer(ownerId, userIds);

    const links = contacts.map(c => privateChatLink(ownerId, c.userId));
    const chats = await this.chatModel
      .find({ link: { $in: links }, type: ChatType.PRIVATE, isDeleted: false })
      .select("_id link")
      .lean()
      .exec();
    const channelIdByLink = new Map(chats.map(c => [c.link, String(c._id)]));
    const channelIds = chats.map(c => String(c._id));
    const states = await this.chatStateModel
      .find({ channelId: { $in: channelIds } })
      .lean()
      .exec();
    const stateByChannel = new Map(states.map(s => [s.channelId, s]));

    // Online dots only for people whose last-seen privacy (both ways) allows it.
    const onlineFlags = await Promise.all(
      contacts.map(c =>
        view.canSeeLastSeen(c.userId)
          ? this.presenceService.isOnline(c.userId)
          : Promise.resolve(false),
      ),
    );

    return contacts.map((c, i) => {
      const user = userById.get(c.userId);
      const link = privateChatLink(ownerId, c.userId);
      const channelId = channelIdByLink.get(link) ?? null;
      const state = channelId ? stateByChannel.get(channelId) : undefined;
      return {
        _id: String(c._id),
        user: user
          ? view.publicUser(user)
          : toPublicUserDto({ _id: c.userId, username: "(deleted user)" }),
        customName: c.customName,
        savedAt: c.createdAt,
        isOnline: onlineFlags[i],
        channelId,
        lastMessageAt: state?.lastMessageAt ?? null,
        lastMessagePreview: state?.lastMessagePreview ?? null,
      };
    });
  }

  async updateContact(
    ownerId: string,
    contactId: string,
    customName: string | null,
  ): Promise<{ success: boolean }> {
    const result = await this.contactModel
      .updateOne({ _id: contactId, ownerId }, { $set: { customName } })
      .exec();
    if (result.matchedCount === 0) {
      throw new NotFoundException("Contact not found");
    }
    return { success: true };
  }

  async removeContact(
    ownerId: string,
    contactId: string,
  ): Promise<{ success: boolean }> {
    await this.contactModel.deleteOne({ _id: contactId, ownerId }).exec();
    return { success: true };
  }
}
