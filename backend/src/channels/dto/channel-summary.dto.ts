import { ApiProperty } from "@nestjs/swagger";
import { ChatType, UserRole } from "src/enum/base.enum";
import { PublicUserDto } from "src/common/dto/user-view.dto";
import type { EffectivePermissions } from "src/chat/permissions";

/**
 * The shape `GET /v1/channels/mine` returns — one row per chat, everything the chat list needs
 * to render without a follow-up request. See docs/plans/BACKEND_PLAN.md B2.
 */
export class ChannelSummaryDto {
  @ApiProperty()
  channelId: string;

  @ApiProperty({ enum: ChatType })
  type: ChatType;

  @ApiProperty({
    description:
      "Chat name for group/channel; blank for private (use otherUser).",
  })
  name: string;

  @ApiProperty({ nullable: true, description: "Group/channel description." })
  description: string | null;

  @ApiProperty({
    description:
      "Public groups/channels show up in search; private ones are invite-only.",
  })
  isPublic: boolean;

  @ApiProperty({ type: [String] })
  image: string[];

  @ApiProperty({
    description:
      "Channels: on = each post shows its author's name next to the time.",
  })
  signature: boolean;

  @ApiProperty({ nullable: true })
  link: string | null;

  @ApiProperty({ enum: UserRole })
  myRole: UserRole;

  @ApiProperty({
    description:
      "What you may do here (chat/permissions.ts EffectivePermissions).",
  })
  myPermissions: EffectivePermissions;

  @ApiProperty()
  isPinned: boolean;

  @ApiProperty()
  isMuted: boolean;

  @ApiProperty({ nullable: true })
  lastReadMessageId: string | null;

  @ApiProperty({ nullable: true })
  lastMessageAt: Date | null;

  @ApiProperty({ nullable: true })
  lastMessagePreview: string | null;

  @ApiProperty({ description: "True when the chat's last message is yours." })
  lastMessageMine: boolean;

  @ApiProperty({
    nullable: true,
    description:
      "For your last message in a direct chat: whether your partner has read it. Null when the last message isn't yours. Groups/channels are always false (read state isn't tracked per member here).",
  })
  lastMessageRead: boolean | null;

  @ApiProperty({
    description:
      "You cleared this chat's history after its last message (Telegram keeps the chat in place, " +
      "with no preview): `lastMessagePreview` is null and the time shouldn't be shown. " +
      "`lastMessageAt` is kept so the list order doesn't jump.",
  })
  historyCleared: boolean;

  @ApiProperty({
    description: "Group/channel only — omitted for private chats.",
  })
  memberCount?: number;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({
    description:
      "True when the chat's last message postdates this member's own lastReadAt (or they've never read it at all). Not a count.",
  })
  unread: boolean;

  @ApiProperty({
    type: PublicUserDto,
    nullable: true,
    description: "Private chats only — the other member.",
  })
  otherUser?: PublicUserDto;

  @ApiProperty({
    required: false,
    description:
      "Groups/channels with a live voice chat: `{ callId, startedAt, participantCount }`. " +
      "Kept current by the `group_call_updated` socket event.",
  })
  activeCall?: {
    callId: string;
    startedAt: number | null;
    participantCount: number;
  };
}
