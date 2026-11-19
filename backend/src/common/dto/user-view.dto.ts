import { ApiProperty } from "@nestjs/swagger";
import {
  PRIVACY_AUDIENCES,
  privacyOf,
  type PrivacyAudience,
  type StoredPrivacyRules,
} from "src/user/schema/privacy";

/**
 * Loosely-typed input accepted by the mappers below — a Mongoose document, a `.lean()`
 * result, or a hand-built object. Never pass `password`/`tokenVersion` through even if
 * present on the source object; the mappers below simply never read them.
 */
export interface UserLike {
  _id: unknown;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  image?: string[] | null;
  avatarVideo?: string | null;
  bio?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  bigEmojis?: boolean | null;
  quickReaction?: string | null;
  quickReactionItem?: QuickReactionItemDto | null;
  lastSeen?: Date | null;
  notificationLevel?: "all" | "mentions" | "none" | null;
  findByUsername?: string | null;
  findByPhoneOrEmail?: string | null;
  privacyRules?: StoredPrivacyRules | null;
}

/**
 * The only shape another user's data may ever take on the wire. Never add
 * email/phoneNumber/tokenVersion/isDeleted here — see docs/plans/BACKEND_PLAN.md B1.
 */
export class PublicUserDto {
  @ApiProperty({ example: "507f1f77bcf86cd799439011" })
  _id: string;

  @ApiProperty({ example: "johndoe" })
  username: string;

  @ApiProperty({ example: "John" })
  firstName: string;

  @ApiProperty({ example: "Doe" })
  lastName: string;

  @ApiProperty({
    example: ["https://example.com/avatar.jpg"],
    type: [String],
    description: "Wire name for the internal `image` field.",
  })
  avatarUrl: string[];

  @ApiProperty({
    nullable: true,
    required: false,
    description:
      "The main profile photo is a video: loop this on the profile (avatarUrl[0] is its poster).",
  })
  avatarVideoUrl?: string | null;

  @ApiProperty({ example: "Software developer & coffee lover" })
  bio: string;
}

export class ProfilePhotoDto {
  @ApiProperty() id: string;
  @ApiProperty() url: string;
  @ApiProperty({ enum: ["image", "video"] }) kind: "image" | "video";
  @ApiProperty({ nullable: true, description: "Still frame for a video" })
  posterUrl: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ description: "The one everybody sees" }) isMain: boolean;
}

export class QuickReactionItemDto {
  @ApiProperty() packItemId: string;
  @ApiProperty() packId: string;
  @ApiProperty() relativePath: string;
  @ApiProperty() thumbPath: string;
  @ApiProperty() stillPath: string;
}

/** My privacy audiences (exceptions: `GET /users/privacy`). */
export class PrivacySettingsDto {
  @ApiProperty({
    enum: PRIVACY_AUDIENCES,
    description: "Who can see my phone number",
  })
  phoneNumber: PrivacyAudience;
  @ApiProperty({ enum: PRIVACY_AUDIENCES, description: "Who can see my email" })
  email: PrivacyAudience;
  @ApiProperty({
    enum: PRIVACY_AUDIENCES,
    description: "Who can see my last seen & online (reciprocal)",
  })
  lastSeen: PrivacyAudience;
  @ApiProperty({
    enum: PRIVACY_AUDIENCES,
    description: "Who can see my profile photos",
  })
  profilePhotos: PrivacyAudience;
  @ApiProperty({ enum: PRIVACY_AUDIENCES, description: "Who can see my bio" })
  bio: PrivacyAudience;
  @ApiProperty({ enum: PRIVACY_AUDIENCES, description: "Who can call me" })
  calls: PrivacyAudience;
  @ApiProperty({
    enum: PRIVACY_AUDIENCES,
    description: "Who can add me to groups and channels",
  })
  groupInvites: PrivacyAudience;
  @ApiProperty({
    enum: PRIVACY_AUDIENCES,
    description: "Who sees a link to my account on my forwarded messages",
  })
  forwards: PrivacyAudience;

  @ApiProperty({
    enum: PRIVACY_AUDIENCES,
    description:
      "Who can find me by my @username (people I share a chat with always can)",
  })
  findByUsername: PrivacyAudience;

  @ApiProperty({
    enum: PRIVACY_AUDIENCES,
    description: "Who can find me by my exact phone number or email",
  })
  findByPhoneOrEmail: PrivacyAudience;
}

/** The authenticated user's own view of themselves — adds fields no one else may see. */
export class MeDto extends PublicUserDto {
  @ApiProperty({ example: "user@example.com" })
  email: string;

  @ApiProperty({ example: "+1234567890" })
  phoneNumber: string;

  @ApiProperty({ example: true })
  bigEmojis: boolean;

  @ApiProperty({ example: "👍" })
  quickReaction: string;

  @ApiProperty({
    nullable: true,
    type: () => QuickReactionItemDto,
    description:
      "Set when the quick reaction is an animated emoji (react with its packItemId); " +
      "`quickReaction` then holds its plain-emoji fallback.",
  })
  quickReactionItem: QuickReactionItemDto | null;

  @ApiProperty({ nullable: true })
  lastSeen: Date | null;

  @ApiProperty({ example: "all", enum: ["all", "mentions", "none"] })
  notificationLevel: "all" | "mentions" | "none";

  @ApiProperty({ type: () => PrivacySettingsDto })
  privacy: PrivacySettingsDto;
}

/**
 * A profile-page view of *another* user — `PublicUserDto` (photos/bio already filtered by the
 * target's privacy) plus `phoneNumber`/`email` only when the target's privacy lets this viewer
 * see them, and what the viewer may do. Built only by `UserService.findOne` through
 * `PrivacyService`, never automatically.
 */
export class ProfileViewDto extends PublicUserDto {
  @ApiProperty({
    required: false,
    description: "Only present if this user's privacy lets you see it",
  })
  phoneNumber?: string;

  @ApiProperty({
    required: false,
    description: "Only present if this user's privacy lets you see it",
  })
  email?: string;

  @ApiProperty({
    required: false,
    description:
      "Whether you may call this user (their calls privacy, and no block either way)",
  })
  canCall?: boolean;

  @ApiProperty({
    required: false,
    description: "Whether you may add this user to a group or channel",
  })
  canAddToGroups?: boolean;
}

export function toPublicUserDto(user: UserLike): PublicUserDto {
  return {
    _id: String(user._id),
    username: user.username ?? "",
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    avatarUrl: user.image ?? [],
    ...(user.avatarVideo ? { avatarVideoUrl: user.avatarVideo } : {}),
    bio: user.bio ?? "",
  };
}

export function toMeDto(user: UserLike): MeDto {
  return {
    ...toPublicUserDto(user),
    email: user.email ?? "",
    phoneNumber: user.phoneNumber ?? "",
    bigEmojis: user.bigEmojis ?? true,
    quickReaction: user.quickReaction ?? "👍",
    quickReactionItem: user.quickReactionItem ?? null,
    lastSeen: user.lastSeen ?? null,
    notificationLevel: user.notificationLevel ?? "all",
    privacy: privacyOf(user),
  };
}

export function toProfileViewDto(
  base: PublicUserDto,
  user: UserLike,
  reveal: { phoneNumber: boolean; email: boolean },
  abilities: { canCall: boolean; canAddToGroups: boolean },
): ProfileViewDto {
  return {
    ...base,
    ...(reveal.phoneNumber && user.phoneNumber
      ? { phoneNumber: user.phoneNumber }
      : {}),
    ...(reveal.email && user.email ? { email: user.email } : {}),
    ...abilities,
  };
}
