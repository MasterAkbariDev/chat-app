import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";
import {
  DEFAULT_FIND_BY_PHONE_OR_EMAIL,
  DEFAULT_FIND_BY_USERNAME,
  PRIVACY_AUDIENCES,
  type PrivacyAudience,
  type StoredPrivacyRules,
} from "./privacy";

export interface QuickReactionItem {
  packItemId: string;
  packId: string;
  relativePath: string;
  thumbPath: string;
  stillPath: string;
}

/** One entry of the user's recent emoji (plain or animated), newest first. `key` identifies it
 * (`u:<emoji>` or `a:<packItemId>`) so a re-used emoji moves to the front instead of repeating.
 * Animated entries keep their media paths (they never change — see QuickReactionItem). */
export interface RecentEmoji {
  key: string;
  /** The emoji itself, for a plain one; null for an animated one. */
  emoji: string | null;
  /** Unicode fallback (plain: the emoji; animated: its keyword emoji). */
  fallback: string;
  item: QuickReactionItem | null;
}

export interface ProfilePhoto {
  _id: Types.ObjectId;
  url: string;
  kind: "image" | "video";
  posterUrl: string | null;
  createdAt: Date;
}

@Schema({
  collection: "user",
  timestamps: true,
  versionKey: false,
  toJSON: {
    transform(_doc, ret: Record<string, unknown>) {
      delete ret.password;
      delete ret.isDeleted;
      return ret;
    },
  },
})
export class User {
  _id: Types.ObjectId;

  @Prop({ default: "" })
  firstName: string;

  @Prop({ default: "" })
  lastName: string;

  @Prop({ lowercase: true, trim: true })
  username: string;

  @Prop({ lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  password: string;

  @Prop({ type: Date, default: new Date() })
  lastSeen: Date;

  /** `[main photo display URL]` — a still (a video's poster) so every list stays cheap.
   *  Kept in step with `photos[0]` by `UserService`; `[]` = no photo. */
  @Prop({ default: [] })
  image: string[];

  /** All profile photos/videos, main first (Telegram-style; everyone can browse them). */
  @Prop({
    type: [
      {
        url: { type: String, required: true },
        kind: { type: String, enum: ["image", "video"], default: "image" },
        posterUrl: { type: String, default: null },
        createdAt: { type: Date, default: () => new Date() },
      },
    ],
    default: [],
  })
  photos: ProfilePhoto[];

  /** The main photo's video when it is one (null otherwise) — played on the profile only. */
  @Prop({ type: String, default: null })
  avatarVideo: string | null;

  @Prop({ default: "" })
  phoneNumber: string;

  @Prop({ default: "" })
  bio: string;

  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Boolean, default: true })
  bigEmojis: boolean;

  @Prop({ type: String, required: true, default: "👍" })
  quickReaction: string;

  /**
   * Set when the quick reaction is an animated emoji from one of the user's packs instead of a
   * plain emoji. Denormalized at pick time (media paths never change — MediaService never
   * deletes) so `/me` can render it without a join. `quickReaction` keeps a plain-emoji
   * fallback (the item's emoji keyword), so older clients keep working.
   */
  @Prop({ type: Object, default: null })
  quickReactionItem: QuickReactionItem | null;

  /** The most recent emoji the user picked, server-side, capped (see RECENT_EMOJI_MAX). */
  @Prop({ type: [Object], default: [] })
  recentEmoji: RecentEmoji[];

  // Written by `timestamps: true`; declared so typed reads can use it.
  createdAt: Date;
  updatedAt: Date;

  // isOnline dropped (B3) — presence now lives in Redis (src/presence/presence.service.ts),
  // never in Mongo.

  /** Incremented to invalidate all outstanding JWTs (logout everywhere, password change). */
  @Prop({ type: Number, default: 0 })
  tokenVersion: number;

  /**
   * Per-account login lockout (B4, docs/plans/BACKEND_PLAN.md) — on top of B0's IP-based
   * throttler, which doesn't stop a distributed attempt against one specific account.
   * `failedLoginAttempts` resets to 0 on a successful login; `lockedUntil` is set once the
   * threshold is hit and cleared automatically once it's in the past (see
   * `AuthService.validateUser`).
   */
  @Prop({ type: Number, default: 0 })
  failedLoginAttempts: number;

  @Prop({ type: Date, default: null })
  lockedUntil: Date | null;

  /**
   * Set by an admin (B10, docs/plans/BACKEND_PLAN.md) — a date in the future means suspended
   * until then; `null` means not suspended. Checked at login (`AuthService.validateUser`), on
   * every authenticated request (`JwtStrategy`, via the same Redis-cached user-state as
   * `isDeleted`), and at gateway connect (`ChatGateway.handleConnection`).
   */
  @Prop({ type: Date, default: null })
  suspendedUntil: Date | null;

  /** Global chat wallpaper applied to all chats */
  @Prop({ type: Types.ObjectId, ref: "Wallpaper", default: null })
  globalWallpaperId: Types.ObjectId | null;

  /**
   * Global push-notification level (B7, docs/plans/BACKEND_PLAN.md) — `NotificationService`
   * checks this per recipient before sending. `mentions` = only when this user is @mentioned;
   * `none` = never push, still delivered over the socket if the app is open.
   */
  @Prop({ type: String, enum: ["all", "mentions", "none"], default: "all" })
  notificationLevel: "all" | "mentions" | "none";

  /**
   * Who may find this account by typing its @username in global search / add-contact
   * (Telegram semantics: "contacts" = people *this user* saved as contacts). People who
   * already share a chat with this user, or that this user saved, always find them.
   * Missing on older documents — read through `privacyOf()` so the default applies.
   */
  @Prop({
    type: String,
    enum: PRIVACY_AUDIENCES,
    default: DEFAULT_FIND_BY_USERNAME,
  })
  findByUsername: PrivacyAudience;

  /** Who may resolve this account by its exact phone number or email (add contact). */
  @Prop({
    type: String,
    enum: PRIVACY_AUDIENCES,
    default: DEFAULT_FIND_BY_PHONE_OR_EMAIL,
  })
  findByPhoneOrEmail: PrivacyAudience;

  /**
   * Every other privacy setting (phone number, email, last seen, photos, bio, calls, groups,
   * forwards) plus the "always allow"/"never allow" exceptions of all of them, keyed by
   * `PrivacyKey`: `{ audience?, allow: userId[], deny: userId[] }`. Read only through
   * `privacyRulesOf()` / `PrivacyService` so defaults apply to older documents.
   */
  @Prop({ type: Object, default: {} })
  privacyRules: StoredPrivacyRules;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ email: 1 }, { unique: true, sparse: true });
UserSchema.index({ username: 1 }, { unique: true, sparse: true });
UserSchema.index({ phoneNumber: 1 }, { sparse: true });
UserSchema.index({ isDeleted: 1 });
// B6: backs GET /v1/search?scope=people — username/name only, never email/phoneNumber.
UserSchema.index({ username: "text", firstName: "text", lastName: "text" });
