import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types, type FilterQuery } from "mongoose";
import { User } from "./schema/user.schema";
import { Block } from "./schema/block.schema";
import { Contact } from "src/contacts/schema/contact.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { ChatType, UserRole } from "src/enum/base.enum";
import { PublicUserDto } from "src/common/dto/user-view.dto";
import { PrivacyService } from "src/privacy/privacy.service";
import { escapeRegex } from "src/common/utils/escape-regex";
import {
  DEFAULT_FIND_BY_PHONE_OR_EMAIL,
  DEFAULT_FIND_BY_USERNAME,
  type PrivacyAudience,
} from "./schema/privacy";

/**
 * Who can find whom (Telegram's model) — the single place every people lookup goes through:
 * global search (`/v1/search?scope=people`), the legacy `/users/search` pickers,
 * `GET /users/:username` and add-contact by username/phone/email.
 *
 * - **By name** (first/last name, or any part of a username): only people the searcher
 *   already knows — their saved contacts and people they share a joined chat with (DM
 *   partners, fellow group members, and members of channels the searcher administers;
 *   ordinary channel subscribers never see each other, as in Telegram).
 * - **Strangers by @username**: a single word of at least {@link MIN_USERNAME_PREFIX}
 *   characters matches usernames that *start with* it; anything shorter must be the exact
 *   username. Only if the target's `findByUsername` allows the searcher.
 * - **Phone / email**: exact match only, only if the target's `findByPhoneOrEmail` allows.
 * - Blocks, either direction, hide people completely.
 *
 * "contacts" audience = people the *target* saved as contacts. A hidden user and a
 * non-existent one produce the same result (empty list / null) so nothing here is an
 * existence oracle; the queries run are the same either way.
 */
export const MIN_USERNAME_PREFIX = 4;
const MAX_CANDIDATES = 200;

/** Every typed word must match the start of a word (start, or after space/_/./-). */
function wordPrefix(token: string): RegExp {
  return new RegExp(`(?:^|[\\s_.\\-])${escapeRegex(token)}`, "i");
}

/** A username clause for strangers, or null when the query can't be a username. */
function usernameClause(query: string): FilterQuery<User> | null {
  const q = query.replace(/^@/, "").trim().toLowerCase();
  if (!q || /\s/.test(q)) return null;
  if (q.length >= MIN_USERNAME_PREFIX) {
    return { username: new RegExp(`^${escapeRegex(q)}`) };
  }
  return { username: q };
}

/**
 * Matches users whose `field` setting lets `viewerId` (saved as a contact by `savedViewer`)
 * find them: "never allow" excludes, "always allow" includes, else the audience decides.
 */
function audienceAllows(
  field: "findByUsername" | "findByPhoneOrEmail",
  fallback: PrivacyAudience,
  savedViewer: Types.ObjectId[],
  viewerId: string,
): FilterQuery<User> {
  const everybody: unknown[] = ["everybody"];
  const contacts: unknown[] = ["contacts"];
  // Documents created before the setting existed have no field — apply the default.
  if (fallback === "everybody") everybody.push(null);
  if (fallback === "contacts") contacts.push(null);
  return {
    [`privacyRules.${field}.deny`]: { $ne: viewerId },
    $or: [
      { [field]: { $in: everybody } },
      { [field]: { $in: contacts }, _id: { $in: savedViewer } },
      { [`privacyRules.${field}.allow`]: viewerId },
    ],
  };
}

export interface ViewerGraph {
  /** Contacts the viewer saved + people sharing a joined chat with them. */
  known: Types.ObjectId[];
  /** People who saved the viewer as a contact. */
  savedViewer: Types.ObjectId[];
  /** Blocked by the viewer, or blocking the viewer. */
  blocked: Types.ObjectId[];
}

const oid = (id: string) => new Types.ObjectId(id);
const toOids = (ids: unknown[]) =>
  ids
    .map(String)
    .filter(s => Types.ObjectId.isValid(s))
    .map(oid);

@Injectable()
export class PeopleDiscoveryService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Block.name) private readonly blockModel: Model<Block>,
    @InjectModel(Contact.name) private readonly contactModel: Model<Contact>,
    @InjectModel(Chat.name) private readonly chatModel: Model<Chat>,
    @InjectModel(ChatMembers.name)
    private readonly chatMembersModel: Model<ChatMembers>,
    private readonly privacy: PrivacyService,
  ) {}

  async viewerGraph(viewerId: string): Promise<ViewerGraph> {
    const me = oid(viewerId);
    const [mySaved, savedMe, blocks, memberships] = await Promise.all([
      this.contactModel.distinct("userId", { ownerId: viewerId }).exec(),
      this.contactModel.distinct("ownerId", { userId: viewerId }).exec(),
      this.blockModel
        .find({ $or: [{ blockerId: me }, { blockedId: me }] })
        .select("blockerId blockedId")
        .lean()
        .exec(),
      this.chatMembersModel
        .find({ userId: viewerId, isJoined: true, isBanned: { $ne: true } })
        .select("channelId role")
        .lean()
        .exec(),
    ]);

    let coMembers: string[] = [];
    if (memberships.length) {
      const roleByChannel = new Map(
        memberships.map(m => [String(m.channelId), m.role]),
      );
      const chats = await this.chatModel
        .find({
          _id: { $in: toOids([...roleByChannel.keys()]) },
          isDeleted: { $ne: true },
        })
        .select("type")
        .lean()
        .exec();
      const eligible = chats
        .filter(
          c =>
            c.type === ChatType.PRIVATE ||
            c.type === ChatType.GROUP ||
            (c.type === ChatType.CHANNEL &&
              [UserRole.OWNER, UserRole.ADMIN].includes(
                roleByChannel.get(String(c._id)) as UserRole,
              )),
        )
        .map(c => String(c._id));
      if (eligible.length) {
        coMembers = await this.chatMembersModel
          .distinct("userId", {
            channelId: { $in: eligible },
            userId: { $ne: viewerId },
            isJoined: true,
            isBanned: { $ne: true },
          })
          .exec();
      }
    }

    const blocked = new Set<string>();
    for (const b of blocks) {
      blocked.add(String(b.blockerId));
      blocked.add(String(b.blockedId));
    }
    blocked.delete(viewerId);
    const known = new Set([...mySaved.map(String), ...coMembers.map(String)]);
    known.delete(viewerId);
    for (const id of blocked) known.delete(id);

    return {
      known: toOids([...known]),
      savedViewer: toOids(savedMe),
      blocked: toOids([...blocked]),
    };
  }

  /** Global people search — see the class comment for the rules. */
  async searchPeople(
    query: string,
    viewerId: string,
    limit: number,
    offset: number,
  ): Promise<PublicUserDto[]> {
    const raw = query.replace(/^@/, "").trim();
    const tokens = raw.split(/\s+/).filter(Boolean).slice(0, 5);
    if (!tokens.length || !Types.ObjectId.isValid(viewerId)) return [];
    const graph = await this.viewerGraph(viewerId);

    const branches: FilterQuery<User>[] = [];
    if (graph.known.length) {
      branches.push({
        _id: { $in: graph.known },
        $and: tokens.map(t => {
          const rx = wordPrefix(t);
          return {
            $or: [{ username: rx }, { firstName: rx }, { lastName: rx }],
          };
        }),
      });
    }
    const handle = usernameClause(raw);
    if (handle) {
      branches.push({
        $and: [
          handle,
          audienceAllows(
            "findByUsername",
            DEFAULT_FIND_BY_USERNAME,
            graph.savedViewer,
            viewerId,
          ),
        ],
      });
    }
    if (!branches.length) return [];

    const users = await this.userModel
      .find({
        isDeleted: false,
        _id: { $ne: oid(viewerId), $nin: graph.blocked },
        $or: branches,
      })
      .select("username firstName lastName image avatarVideo bio")
      .limit(MAX_CANDIDATES)
      .lean()
      .exec();

    const knownSet = new Set(graph.known.map(String));
    const q = raw.toLowerCase();
    const score = (u: {
      _id: unknown;
      username?: string;
      firstName?: string;
      lastName?: string;
    }) => {
      const username = (u.username ?? "").toLowerCase();
      const full = [u.firstName, u.lastName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const base =
        username === q || full === q
          ? 0
          : username.startsWith(q)
            ? 1
            : full.startsWith(q)
              ? 2
              : 3;
      // People you know rank above strangers with an equally good match.
      return base * 2 + (knownSet.has(String(u._id)) ? 0 : 1);
    };
    const page = users
      .sort(
        (a, b) =>
          score(a) - score(b) ||
          (a.username ?? "").localeCompare(b.username ?? ""),
      )
      .slice(offset, offset + limit);
    const view = await this.privacy.forViewer(
      viewerId,
      page.map(u => u._id),
    );
    return page.map(u => view.publicUser(u));
  }

  /**
   * Exact-identifier lookup (add contact, `GET /users/:username`). Returns the user's id, or
   * null when there's no such user *or* they're hidden from this viewer — callers must treat
   * both identically.
   */
  async resolveExact(
    viewerId: string,
    by: { username?: string; phone?: string; email?: string },
  ): Promise<string | null> {
    if (!Types.ObjectId.isValid(viewerId)) return null;
    let match: FilterQuery<User>;
    let field: "findByUsername" | "findByPhoneOrEmail";
    let fallback: PrivacyAudience;
    if (by.username !== undefined) {
      const u = by.username.replace(/^@/, "").trim().toLowerCase();
      if (!u) return null;
      match = { username: u };
      field = "findByUsername";
      fallback = DEFAULT_FIND_BY_USERNAME;
    } else if (by.phone !== undefined) {
      const p = by.phone.trim();
      if (!p) return null;
      match = { phoneNumber: p };
      field = "findByPhoneOrEmail";
      fallback = DEFAULT_FIND_BY_PHONE_OR_EMAIL;
    } else if (by.email !== undefined) {
      const e = by.email.trim().toLowerCase();
      if (!e) return null;
      match = { email: e };
      field = "findByPhoneOrEmail";
      fallback = DEFAULT_FIND_BY_PHONE_OR_EMAIL;
    } else {
      return null;
    }

    const graph = await this.viewerGraph(viewerId);
    const allowed: FilterQuery<User>[] = [
      audienceAllows(field, fallback, graph.savedViewer, viewerId),
      { _id: oid(viewerId) },
    ];
    // People who already know you can open your profile by username (e.g. an @mention
    // in a shared group). Phone/email stay strictly governed by the setting.
    if (field === "findByUsername" && graph.known.length) {
      allowed.push({ _id: { $in: graph.known } });
    }
    const user = await this.userModel
      .findOne({
        ...match,
        isDeleted: false,
        _id: { $nin: graph.blocked },
        $or: allowed,
      })
      .select("_id")
      .lean()
      .exec();
    return user ? String(user._id) : null;
  }
}
