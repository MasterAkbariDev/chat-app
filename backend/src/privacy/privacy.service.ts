import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { User } from "src/user/schema/user.schema";
import { Contact } from "src/contacts/schema/contact.schema";
import {
  MAX_PRIVACY_EXCEPTIONS,
  PRIVACY_KEYS,
  TOP_LEVEL_AUDIENCE_KEYS,
  isAudience,
  isPrivacyKey,
  lastSeenBucket,
  privacyOf,
  privacyRuleOf,
  privacyRulesOf,
  ruleAllows,
  ruleAllowsEveryone,
  type LastSeenBucket,
  type PrivacyAudience,
  type PrivacyCarrier,
  type PrivacyKey,
  type PrivacyRule,
  type PrivacyRules,
  type PrivacySettings,
} from "src/user/schema/privacy";
import {
  toPublicUserDto,
  type PublicUserDto,
  type UserLike,
} from "src/common/dto/user-view.dto";

const RULE_FIELDS = "findByUsername findByPhoneOrEmail privacyRules";
const CACHE_TTL_MS = 10_000;
const CACHE_MAX = 5000;

/** A user id as a string, from a string, an ObjectId or anything carrying `_id`. */
export function idString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Types.ObjectId) return v.toHexString();
  if (v && typeof v === "object" && "_id" in v) return idString(v._id);
  return "";
}

function validIds(ids: Iterable<unknown>): string[] {
  const out = new Set<string>();
  for (const raw of ids) {
    const s = idString(raw);
    if (s && Types.ObjectId.isValid(s)) out.add(s);
  }
  return [...out];
}

/**
 * Settings + "who saved whom" for a set of people — everything needed to evaluate any rule
 * between any two of them without another query. Built by {@link PrivacyService.forViewer}
 * (one viewer, many targets) or {@link PrivacyService.forTarget} (one target, many viewers).
 */
export class PrivacyGraph {
  constructor(
    private readonly rules: Map<string, PrivacyRules>,
    /** `${ownerId}>${savedUserId}` for every contact edge loaded. */
    private readonly saved: Set<string>,
  ) {}

  ruleOf(ownerId: string, key: PrivacyKey): PrivacyRule {
    return (this.rules.get(ownerId) ?? privacyRulesOf({}))[key];
  }

  hasSaved(ownerId: string, userId: string): boolean {
    return this.saved.has(`${ownerId}>${userId}`);
  }

  /** May `viewerId` see/do `key` on `ownerId`? */
  allows(ownerId: string, viewerId: string, key: PrivacyKey): boolean {
    return ruleAllows(
      this.ruleOf(ownerId, key),
      ownerId,
      viewerId,
      this.hasSaved(ownerId, viewerId),
    );
  }

  /** Exact last seen / online is visible only both ways (Telegram's reciprocity). */
  lastSeenVisible(ownerId: string, viewerId: string): boolean {
    if (ownerId === viewerId) return true;
    return (
      this.allows(ownerId, viewerId, "lastSeen") &&
      this.allows(viewerId, ownerId, "lastSeen")
    );
  }
}

export interface PresenceView {
  userId: string;
  isOnline: boolean;
  lastSeen: Date | string | null;
  /** Set (and the two fields above blanked) when the exact values are hidden from you. */
  lastSeenBucket?: LastSeenBucket;
}

/** One viewer's window onto other people — every serializer of another user goes through it. */
export class PrivacyView {
  constructor(
    readonly viewerId: string,
    readonly graph: PrivacyGraph,
  ) {}

  can(targetId: unknown, key: PrivacyKey): boolean {
    return this.graph.allows(idString(targetId), this.viewerId, key);
  }

  canSeeLastSeen(targetId: unknown): boolean {
    return this.graph.lastSeenVisible(idString(targetId), this.viewerId);
  }

  /** `toPublicUserDto`, minus photos and bio when the target hides them from this viewer. */
  publicUser(user: UserLike): PublicUserDto {
    const dto = toPublicUserDto(user);
    return applyVisibility(dto, {
      photos: this.can(dto._id, "profilePhotos"),
      bio: this.can(dto._id, "bio"),
    });
  }

  presence(
    targetId: string,
    lastSeen: Date | string | null | undefined,
    isOnline: boolean,
  ): PresenceView {
    if (this.canSeeLastSeen(targetId)) {
      return { userId: targetId, isOnline, lastSeen: lastSeen ?? null };
    }
    return {
      userId: targetId,
      isOnline: false,
      lastSeen: null,
      lastSeenBucket: lastSeenBucket(lastSeen, isOnline),
    };
  }
}

export function applyVisibility<T extends PublicUserDto>(
  dto: T,
  visible: { photos: boolean; bio: boolean },
): T {
  const out: T = { ...dto };
  if (!visible.photos) {
    out.avatarUrl = [];
    delete out.avatarVideoUrl;
  }
  if (!visible.bio) out.bio = "";
  return out;
}

/** The settings page's view: each rule with its exception lists resolved to people. */
export type PrivacyRuleView = {
  audience: PrivacyAudience;
  allow: PublicUserDto[];
  deny: PublicUserDto[];
};
export type PrivacyRulesView = Record<PrivacyKey, PrivacyRuleView>;

export type PrivacyPatch = Partial<
  Record<
    PrivacyKey,
    | PrivacyAudience
    | { audience?: PrivacyAudience; allow?: string[]; deny?: string[] }
  >
>;

/**
 * Telegram's privacy model, enforced centrally. Anything that shows one user's data to another
 * (profile, chat list, members, messages, search, contacts, presence, calls) gets a
 * {@link PrivacyView} from here and serializes through it. Two queries per batch, never one per
 * person: the targets' settings, and the contact edges between viewer and targets.
 */
@Injectable()
export class PrivacyService {
  private readonly cache = new Map<
    string,
    { rules: PrivacyRules; at: number }
  >();

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Contact.name) private readonly contactModel: Model<Contact>,
  ) {}

  private async loadRules(ids: string[]): Promise<Map<string, PrivacyRules>> {
    const map = new Map<string, PrivacyRules>();
    if (!ids.length) return map;
    const users = await this.userModel
      .find({ _id: { $in: ids.map(i => new Types.ObjectId(i)) } })
      .select(RULE_FIELDS)
      .lean()
      .exec();
    for (const u of users) {
      const rules = privacyRulesOf(u);
      map.set(String(u._id), rules);
      this.remember(String(u._id), rules);
    }
    return map;
  }

  private remember(userId: string, rules: PrivacyRules) {
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(userId, { rules, at: Date.now() });
  }

  /** Short-lived cached read for hot broadcast paths (every message send). */
  private async cachedRules(userId: string): Promise<PrivacyRules> {
    const hit = this.cache.get(userId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rules;
    const map = await this.loadRules(validIds([userId]));
    return map.get(userId) ?? privacyRulesOf({});
  }

  /** One viewer looking at many people. */
  async forViewer(
    viewerId: string,
    targetIds: Iterable<unknown>,
  ): Promise<PrivacyView> {
    const targets = validIds(targetIds).filter(t => t !== viewerId);
    if (!targets.length || !Types.ObjectId.isValid(viewerId)) {
      return new PrivacyView(viewerId, new PrivacyGraph(new Map(), new Set()));
    }
    const [rules, edges] = await Promise.all([
      this.loadRules([...targets, viewerId]),
      this.contactModel
        .find({
          $or: [
            { ownerId: { $in: targets }, userId: viewerId },
            { ownerId: viewerId, userId: { $in: targets } },
          ],
        })
        .select("ownerId userId")
        .lean()
        .exec(),
    ]);
    return new PrivacyView(
      viewerId,
      new PrivacyGraph(
        rules,
        new Set(edges.map(e => `${e.ownerId}>${e.userId}`)),
      ),
    );
  }

  /** One person seen by many viewers (presence fan-out). */
  async forTarget(
    targetId: string,
    viewerIds: Iterable<unknown>,
  ): Promise<PrivacyGraph> {
    const viewers = validIds(viewerIds).filter(v => v !== targetId);
    if (!viewers.length || !Types.ObjectId.isValid(targetId)) {
      return new PrivacyGraph(new Map(), new Set());
    }
    const [rules, edges] = await Promise.all([
      this.loadRules([...viewers, targetId]),
      this.contactModel
        .find({
          $or: [
            { ownerId: targetId, userId: { $in: viewers } },
            { ownerId: { $in: viewers }, userId: targetId },
          ],
        })
        .select("ownerId userId")
        .lean()
        .exec(),
    ]);
    return new PrivacyGraph(
      rules,
      new Set(edges.map(e => `${e.ownerId}>${e.userId}`)),
    );
  }

  /**
   * For a room broadcast about `ownerId` (e.g. a message they sent): `everyone` when the rule
   * lets anybody in (one emit is enough), otherwise `allows(viewerId)` per recipient.
   * Cached for a few seconds — this runs on every message send.
   */
  async audienceOf(
    ownerId: string,
    key: PrivacyKey,
  ): Promise<{ everyone: boolean; allows: (viewerId: string) => boolean }> {
    const rule = (await this.cachedRules(ownerId))[key];
    if (ruleAllowsEveryone(rule)) return { everyone: true, allows: () => true };
    const saved =
      rule.audience === "contacts"
        ? new Set(
            (
              await this.contactModel.distinct("userId", { ownerId }).exec()
            ).map(String),
          )
        : new Set<string>();
    return {
      everyone: false,
      allows: viewerId =>
        ruleAllows(rule, ownerId, viewerId, saved.has(viewerId)),
    };
  }

  /** May `viewerId` do/see `key` on `targetId`? (single check — prefer `forViewer` for lists) */
  async allows(targetId: string, viewerId: string, key: PrivacyKey) {
    return (await this.forViewer(viewerId, [targetId])).can(targetId, key);
  }

  // ---- The owner's own settings ------------------------------------------------------------

  async getSettings(userId: string): Promise<PrivacyRulesView> {
    const user = await this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select(RULE_FIELDS)
      .lean()
      .exec();
    if (!user) throw new NotFoundException("User not found");
    return this.resolveRules(userId, privacyRulesOf(user));
  }

  async audiencesOf(userId: string): Promise<PrivacySettings> {
    const user = await this.userModel
      .findById(userId)
      .select(RULE_FIELDS)
      .lean()
      .exec();
    return privacyOf(user ?? {});
  }

  private async resolveRules(
    ownerId: string,
    rules: PrivacyRules,
  ): Promise<PrivacyRulesView> {
    const everyone = new Set<string>();
    for (const k of PRIVACY_KEYS) {
      rules[k].allow.forEach(i => everyone.add(i));
      rules[k].deny.forEach(i => everyone.add(i));
    }
    const ids = validIds(everyone);
    const [users, view] = await Promise.all([
      ids.length
        ? this.userModel
            .find({
              _id: { $in: ids.map(i => new Types.ObjectId(i)) },
              isDeleted: false,
            })
            .select("username firstName lastName image avatarVideo bio")
            .lean()
            .exec()
        : Promise.resolve([]),
      this.forViewer(ownerId, ids),
    ]);
    const byId = new Map(users.map(u => [String(u._id), view.publicUser(u)]));
    const pick = (list: string[]) =>
      list.map(i => byId.get(i)).filter((u): u is PublicUserDto => !!u);
    return Object.fromEntries(
      PRIVACY_KEYS.map(k => [
        k,
        {
          audience: rules[k].audience,
          allow: pick(rules[k].allow),
          deny: pick(rules[k].deny),
        },
      ]),
    ) as PrivacyRulesView;
  }

  /**
   * Applies a patch. Each key takes either an audience string (old clients) or
   * `{ audience?, allow?, deny? }`. A list replaces the stored list; anyone added to one list
   * is taken off the other.
   */
  async updateSettings(
    userId: string,
    patch: Record<string, unknown>,
  ): Promise<PrivacyRulesView> {
    const user = await this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select(RULE_FIELDS)
      .lean()
      .exec();
    if (!user) throw new NotFoundException("User not found");

    const $set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === undefined) continue;
      if (!isPrivacyKey(key)) {
        throw new BadRequestException(`Unknown privacy setting: ${key}`);
      }
      const current = privacyRuleOf(user, key);
      const change = parseRulePatch(key, value, userId);
      let { allow, deny } = current;
      if (change.allow) {
        allow = change.allow;
        if (!change.deny) deny = deny.filter(i => !allow.includes(i));
      }
      if (change.deny) {
        deny = change.deny;
        if (!change.allow) allow = allow.filter(i => !deny.includes(i));
      }
      if (allow.some(i => deny.includes(i))) {
        throw new BadRequestException(
          `${key}: someone can't be in both "always allow" and "never allow"`,
        );
      }
      if (change.audience) {
        if ((TOP_LEVEL_AUDIENCE_KEYS as readonly string[]).includes(key)) {
          $set[key] = change.audience;
        } else {
          $set[`privacyRules.${key}.audience`] = change.audience;
        }
      }
      if (change.allow || change.deny) {
        $set[`privacyRules.${key}.allow`] = allow;
        $set[`privacyRules.${key}.deny`] = deny;
      }
    }

    let saved: PrivacyCarrier = user;
    if (Object.keys($set).length) {
      const updated = await this.userModel
        .findOneAndUpdate(
          { _id: userId, isDeleted: false },
          { $set },
          { new: true },
        )
        .select(RULE_FIELDS)
        .lean()
        .exec();
      if (!updated) throw new NotFoundException("User not found");
      saved = updated;
    }
    const rules = privacyRulesOf(saved);
    this.remember(userId, rules);
    return this.resolveRules(userId, rules);
  }
}

function parseRulePatch(
  key: PrivacyKey,
  value: unknown,
  ownerId: string,
): { audience?: PrivacyAudience; allow?: string[]; deny?: string[] } {
  if (typeof value === "string") {
    if (!isAudience(value)) {
      throw new BadRequestException(
        `${key} must be one of: everybody, contacts, nobody`,
      );
    }
    return { audience: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException(
      `${key} must be an audience or { audience, allow, deny }`,
    );
  }
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) {
    if (!["audience", "allow", "deny"].includes(k)) {
      throw new BadRequestException(`${key}.${k} is not a privacy field`);
    }
  }
  const out: { audience?: PrivacyAudience; allow?: string[]; deny?: string[] } =
    {};
  if (v.audience !== undefined) {
    if (!isAudience(v.audience)) {
      throw new BadRequestException(
        `${key}.audience must be one of: everybody, contacts, nobody`,
      );
    }
    out.audience = v.audience;
  }
  for (const list of ["allow", "deny"] as const) {
    if (v[list] === undefined) continue;
    const arr = v[list];
    if (
      !Array.isArray(arr) ||
      arr.some(i => typeof i !== "string" || !Types.ObjectId.isValid(i))
    ) {
      throw new BadRequestException(
        `${key}.${list} must be a list of user ids`,
      );
    }
    const ids = [...new Set(arr as string[])].filter(i => i !== ownerId);
    if (ids.length > MAX_PRIVACY_EXCEPTIONS) {
      throw new BadRequestException(
        `${key}.${list} can hold at most ${MAX_PRIVACY_EXCEPTIONS} people`,
      );
    }
    out[list] = ids;
  }
  return out;
}
