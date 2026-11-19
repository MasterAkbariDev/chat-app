/**
 * Telegram-style privacy. Every setting is an audience (everybody / my contacts / nobody) plus
 * two exception lists: "always allow" and "never allow" (user ids). "contacts" means people that
 * the *owner of the setting* has saved as contacts — not people who saved them.
 *
 * Evaluation (see {@link ruleAllows}): the owner always sees their own data; "never allow" beats
 * everything; then "always allow"; then the audience.
 */
export const PRIVACY_AUDIENCES = ["everybody", "contacts", "nobody"] as const;
export type PrivacyAudience = (typeof PRIVACY_AUDIENCES)[number];

export const PRIVACY_KEYS = [
  /** Who can see my phone number. */
  "phoneNumber",
  /** Who can see my email address. */
  "email",
  /** Who can see my exact last-seen time and when I'm online (reciprocal). */
  "lastSeen",
  /** Who can see my profile photos and videos (avatar + gallery). */
  "profilePhotos",
  /** Who can see my bio. */
  "bio",
  /** Who can call me. */
  "calls",
  /** Who can add me to groups and channels. */
  "groupInvites",
  /** Who can see a link to my account on messages of mine that others forward. */
  "forwards",
  /** Who can find me by my @username. */
  "findByUsername",
  /** Who can find me by my exact phone number or email. */
  "findByPhoneOrEmail",
] as const;
export type PrivacyKey = (typeof PRIVACY_KEYS)[number];

/** Usernames are meant to be shared, so they're findable unless the user opts out. */
export const DEFAULT_FIND_BY_USERNAME: PrivacyAudience = "everybody";
/** Phone/email are private by default: only people the user saved can look them up. */
export const DEFAULT_FIND_BY_PHONE_OR_EMAIL: PrivacyAudience = "contacts";

export const PRIVACY_DEFAULTS: Record<PrivacyKey, PrivacyAudience> = {
  phoneNumber: "contacts",
  email: "nobody",
  lastSeen: "everybody",
  profilePhotos: "everybody",
  bio: "everybody",
  calls: "everybody",
  groupInvites: "everybody",
  forwards: "everybody",
  findByUsername: DEFAULT_FIND_BY_USERNAME,
  findByPhoneOrEmail: DEFAULT_FIND_BY_PHONE_OR_EMAIL,
};

/**
 * The two discovery settings keep their audience in the old top-level user fields
 * (`findByUsername` / `findByPhoneOrEmail`) because the people-search queries filter on them
 * in Mongo; every other audience, and all exception lists, live in `user.privacyRules`.
 */
export const TOP_LEVEL_AUDIENCE_KEYS = [
  "findByUsername",
  "findByPhoneOrEmail",
] as const satisfies readonly PrivacyKey[];

export const MAX_PRIVACY_EXCEPTIONS = 1000;

export interface PrivacyRule {
  audience: PrivacyAudience;
  /** "Always allow" — user ids. */
  allow: string[];
  /** "Never allow" — user ids. */
  deny: string[];
}

export type PrivacyRules = Record<PrivacyKey, PrivacyRule>;
/** Just the audiences — what `/me.privacy` carries. */
export type PrivacySettings = Record<PrivacyKey, PrivacyAudience>;

/** How `user.privacyRules` is stored (all parts optional; older documents have nothing). */
export type StoredPrivacyRules = Partial<
  Record<
    PrivacyKey,
    { audience?: string | null; allow?: unknown; deny?: unknown } | null
  >
>;

export interface PrivacyCarrier {
  findByUsername?: string | null;
  findByPhoneOrEmail?: string | null;
  privacyRules?: StoredPrivacyRules | null;
}

export function isAudience(v: unknown): v is PrivacyAudience {
  return (PRIVACY_AUDIENCES as readonly string[]).includes(v as string);
}

export function isPrivacyKey(v: unknown): v is PrivacyKey {
  return (PRIVACY_KEYS as readonly string[]).includes(v as string);
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** One setting, with defaults applied for documents created before it existed. */
export function privacyRuleOf(
  user: PrivacyCarrier,
  key: PrivacyKey,
): PrivacyRule {
  const stored = user.privacyRules?.[key] ?? null;
  const raw = (TOP_LEVEL_AUDIENCE_KEYS as readonly string[]).includes(key)
    ? user[key as (typeof TOP_LEVEL_AUDIENCE_KEYS)[number]]
    : stored?.audience;
  return {
    audience: isAudience(raw) ? raw : PRIVACY_DEFAULTS[key],
    allow: ids(stored?.allow),
    deny: ids(stored?.deny),
  };
}

export function privacyRulesOf(user: PrivacyCarrier): PrivacyRules {
  return Object.fromEntries(
    PRIVACY_KEYS.map(k => [k, privacyRuleOf(user, k)]),
  ) as PrivacyRules;
}

/** Reads a user's audiences, applying defaults for documents created before they existed. */
export function privacyOf(user: PrivacyCarrier): PrivacySettings {
  return Object.fromEntries(
    PRIVACY_KEYS.map(k => [k, privacyRuleOf(user, k).audience]),
  ) as PrivacySettings;
}

/**
 * Does `rule` (owned by `ownerId`) let `viewerId` in? `ownerSavedViewer` = the owner has the
 * viewer saved as a contact.
 */
export function ruleAllows(
  rule: PrivacyRule,
  ownerId: string,
  viewerId: string,
  ownerSavedViewer: boolean,
): boolean {
  if (ownerId === viewerId) return true;
  if (rule.deny.includes(viewerId)) return false;
  if (rule.allow.includes(viewerId)) return true;
  if (rule.audience === "everybody") return true;
  if (rule.audience === "contacts") return ownerSavedViewer;
  return false;
}

/** True when `rule` lets in every possible viewer (so a broadcast needs no per-viewer split). */
export function ruleAllowsEveryone(rule: PrivacyRule): boolean {
  return rule.audience === "everybody" && rule.deny.length === 0;
}

/**
 * What people who can't see your exact last seen get instead (Telegram's approximations).
 * Online right now, or seen in the last 3 days → "recently".
 */
export type LastSeenBucket =
  "recently" | "within_week" | "within_month" | "long_ago";

const DAY = 24 * 60 * 60 * 1000;

export function lastSeenBucket(
  lastSeen: Date | string | null | undefined,
  isOnline: boolean,
  now = Date.now(),
): LastSeenBucket {
  if (isOnline) return "recently";
  const t = lastSeen ? new Date(lastSeen).getTime() : NaN;
  if (!Number.isFinite(t)) return "long_ago";
  const age = now - t;
  if (age <= 3 * DAY) return "recently";
  if (age <= 7 * DAY) return "within_week";
  if (age <= 30 * DAY) return "within_month";
  return "long_ago";
}
