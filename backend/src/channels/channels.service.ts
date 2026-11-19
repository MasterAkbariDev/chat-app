import { Injectable, Optional } from "@nestjs/common";
import { effectivePermissions } from "src/chat/permissions";
import { InjectModel } from "@nestjs/mongoose";
import { Model, PipelineStage, Types } from "mongoose";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { ChatType } from "src/enum/base.enum";
import { ChannelSummaryDto } from "./dto/channel-summary.dto";
import { FoldersService } from "src/folders/folders.service";
import { ChatFolderFilters } from "src/folders/schema/chat-folder.schema";
import { PrivacyService, PrivacyView } from "src/privacy/privacy.service";
import { CallStateService } from "src/calls/call-state.service";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

export interface ListMineResult {
  items: ChannelSummaryDto[];
  nextCursor: string | null;
}

/**
 * Backs `GET /v1/channels/mine`. One aggregation for the whole page (pinned chats always
 * included, non-pinned chats keyset-paginated by `chat_state.lastMessageAt`) — replaces the
 * legacy `ChatService.findUserJoinedChatsWithDisplay`'s N+1 (a separate query per DM to find
 * the other member). See docs/plans/BACKEND_PLAN.md B2.
 */
@Injectable()
export class ChannelsService {
  constructor(
    @InjectModel(ChatMembers.name)
    private readonly chatMembersModel: Model<ChatMembers>,
    private readonly foldersService: FoldersService,
    private readonly privacy: PrivacyService,
    @Optional() private readonly callState?: CallStateService,
  ) {}

  /** Folder filters applied server-side, inside the same aggregation (B6) — never a
   *  separate query per filter. */
  private buildFolderMatch(filters: ChatFolderFilters): PipelineStage[] {
    const stages: PipelineStage[] = [];
    const chatMatch: Record<string, unknown> = {};
    if (filters.includeTypes?.length) {
      chatMatch["chat.type"] = { $in: filters.includeTypes };
    }
    if (filters.includeTags?.length) {
      chatMatch["chat.tags"] = { $in: filters.includeTags };
    }
    if (filters.includeChannelIds?.length) {
      chatMatch.channelId = { $in: filters.includeChannelIds };
    }
    if (filters.excludeChannelIds?.length) {
      chatMatch.channelId = {
        ...(chatMatch.channelId as Record<string, unknown> | undefined),
        $nin: filters.excludeChannelIds,
      };
    }
    if (Object.keys(chatMatch).length) stages.push({ $match: chatMatch });
    return stages;
  }

  /** Drag-to-reorder: positions follow the given order; only rows already pinned move. */
  async reorderPins(
    userId: string,
    channelIds: string[],
  ): Promise<{ success: true }> {
    const unique = [...new Set(channelIds)];
    if (unique.length) {
      await this.chatMembersModel.bulkWrite(
        unique.map((channelId, index) => ({
          updateOne: {
            filter: { userId, channelId, isPinned: true },
            update: { $set: { pinOrder: index } },
          },
        })),
      );
    }
    return { success: true };
  }

  async listMine(
    userId: string,
    opts: { limit?: number; cursor?: string | null; folderId?: string } = {},
  ): Promise<ListMineResult> {
    const limit = Math.min(
      Math.max(opts.limit ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;

    const folder = opts.folderId
      ? await this.foldersService.getOwnedFolder(userId, opts.folderId)
      : null;

    const rows = await this.chatMembersModel.aggregate<{
      pinned: RawChannelRow[];
      rest: RawChannelRow[];
    }>([
      { $match: { userId, isJoined: true, isBanned: { $ne: true } } },
      {
        $addFields: {
          channelObjectId: { $toObjectId: "$channelId" },
        },
      },
      {
        $lookup: {
          from: "chats",
          localField: "channelObjectId",
          foreignField: "_id",
          as: "chat",
        },
      },
      { $unwind: "$chat" },
      { $match: { "chat.isDeleted": false } },
      ...(folder ? this.buildFolderMatch(folder.filters) : []),
      {
        $lookup: {
          from: "chat_state",
          localField: "channelId",
          foreignField: "channelId",
          as: "state",
        },
      },
      { $unwind: { path: "$state", preserveNullAndEmptyArrays: true } },
      // Direct chats: the other member's read pointer, for the read tick on your last message.
      {
        $lookup: {
          from: this.chatMembersModel.collection.name,
          let: { channel: "$channelId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$channelId", "$$channel"] },
                    { $ne: ["$userId", userId] },
                  ],
                },
              },
            },
            { $project: { _id: 0, lastReadMessageId: 1 } },
            { $limit: 1 },
          ],
          as: "peerMember",
        },
      },
      // This member's own last visible message: their delete-for-me override while it's
      // still anchored to the channel's current last message, else the channel's.
      {
        $addFields: {
          overrideActive: {
            $and: [
              { $ne: [{ $ifNull: ["$lastVisibleOverride", null] }, null] },
              {
                $eq: [
                  "$lastVisibleOverride.anchorAt",
                  { $ifNull: ["$state.lastMessageAt", null] },
                ],
              },
            ],
          },
        },
      },
      {
        $addFields: {
          effLastAt: {
            $cond: [
              "$overrideActive",
              "$lastVisibleOverride.lastMessageAt",
              { $ifNull: ["$state.lastMessageAt", null] },
            ],
          },
          pinSort: { $ifNull: ["$pinOrder", Number.MAX_SAFE_INTEGER] },
        },
      },
      ...(folder?.filters.onlyUnread
        ? [
            {
              $match: {
                $expr: {
                  $and: [
                    { $ne: ["$effLastAt", null] },
                    {
                      $or: [
                        { $eq: ["$lastReadAt", null] },
                        { $lt: ["$lastReadAt", "$effLastAt"] },
                      ],
                    },
                    // Nothing unread once you've cleared the history past it.
                    {
                      $or: [
                        { $eq: [{ $ifNull: ["$hiddenAt", null] }, null] },
                        { $gt: ["$effLastAt", "$hiddenAt"] },
                      ],
                    },
                  ],
                },
              },
            },
          ]
        : []),
      {
        $lookup: {
          from: "chatmembers",
          let: { chId: "$channelId", myId: userId },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$channelId", "$$chId"] },
                    { $ne: ["$userId", "$$myId"] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "otherMembership",
        },
      },
      {
        $unwind: { path: "$otherMembership", preserveNullAndEmptyArrays: true },
      },
      {
        $addFields: {
          otherUserObjectId: {
            $convert: {
              input: "$otherMembership.userId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $lookup: {
          from: "user",
          localField: "otherUserObjectId",
          foreignField: "_id",
          as: "otherUser",
        },
      },
      { $unwind: { path: "$otherUser", preserveNullAndEmptyArrays: true } },
      {
        $facet: {
          pinned: [
            { $match: { isPinned: true } },
            // Your drag order first; chats pinned before ordering existed after, by recency.
            { $sort: { pinSort: 1, effLastAt: -1 } },
          ],
          rest: [
            {
              $match: {
                isPinned: { $ne: true },
                ...(cursorDate ? { effLastAt: { $lt: cursorDate } } : {}),
              },
            },
            { $sort: { effLastAt: -1 } },
            { $limit: limit + 1 },
          ],
        },
      },
    ] as PipelineStage[]);

    const facet = rows[0] ?? { pinned: [], rest: [] };
    const hasMore = facet.rest.length > limit;
    const restPage = hasMore ? facet.rest.slice(0, limit) : facet.rest;
    const nextCursor = hasMore
      ? (restPage[restPage.length - 1]?.effLastAt?.toISOString() ?? null)
      : null;

    const rowsOut = [...facet.pinned, ...restPage];
    // DM partners' photos/bio as their privacy lets this viewer see them — one batch.
    const view = await this.privacy.forViewer(
      userId,
      rowsOut.map(r => r.otherUser?._id).filter(Boolean),
    );
    const items = rowsOut.map(r => toChannelSummaryDto(r, view, userId));
    await this.attachActiveCalls(items);
    return { items, nextCursor };
  }

  /** Group/channel rows with a live voice chat get `activeCall` (the chat-list indicator and
   *  the chat's top bar on open). One Redis round trip for the page; best-effort — a Redis
   *  hiccup just means no indicator, never a failed chat list. */
  private async attachActiveCalls(items: ChannelSummaryDto[]): Promise<void> {
    if (!this.callState) return;
    const groupIds = items
      .filter(i => i.type === ChatType.GROUP || i.type === ChatType.CHANNEL)
      .map(i => i.channelId);
    if (!groupIds.length) return;
    try {
      const calls = await this.callState.getActiveCallsForChannels(groupIds);
      for (const item of items) {
        const call = calls.get(item.channelId);
        if (!call || call.isPrivate) continue;
        item.activeCall = {
          callId: call.callId,
          startedAt: call.startedAt,
          participantCount: call.participantIds.length,
        };
      }
    } catch {
      // No indicator this time.
    }
  }
}

interface RawChannelRow {
  channelId: string;
  role: string;
  adminRights?: Record<string, boolean> | null;
  permissions?: Record<string, boolean> | null;
  mutedByAdmin?: boolean;
  isPinned?: boolean;
  isMuted?: boolean;
  lastReadMessageId?: string | null;
  lastReadAt?: Date | null;
  /** "Clear history" / left-a-DM boundary: messages up to it are hidden for this member. */
  hiddenAt?: Date | null;
  pinOrder?: number | null;
  /** Computed in the aggregation: whether `lastVisibleOverride` applies right now. */
  overrideActive?: boolean;
  lastVisibleOverride?: {
    lastMessageAt?: Date | null;
    lastMessagePreview?: string | null;
  } | null;
  /** Computed: this member's own last visible message time (override or channel's). */
  effLastAt?: Date | null;
  chat: {
    _id: Types.ObjectId;
    type: ChatType;
    name: string;
    description?: string | null;
    isPublic?: boolean;
    signature?: boolean;
    defaultPermissions?: Record<string, boolean> | null;
    image?: string[];
    link?: string | null;
    tags?: string[];
  };
  state?: {
    lastMessageAt?: Date | null;
    lastMessagePreview?: string | null;
    lastMessageId?: string | null;
    lastMessageSenderId?: string | null;
    memberCount?: number;
  };
  /** The other member's membership (direct chats), from the same aggregation: their read pointer. */
  peerMember?: { lastReadMessageId?: string | null }[];
  otherUser?: {
    _id: Types.ObjectId;
    username?: string;
    firstName?: string;
    lastName?: string;
    image?: string[];
    avatarVideo?: string | null;
    bio?: string;
  };
}

function toChannelSummaryDto(
  row: RawChannelRow,
  view: PrivacyView,
  viewerId: string,
): ChannelSummaryDto {
  const isPrivate = row.chat.type === ChatType.PRIVATE;
  const override = row.overrideActive ? row.lastVisibleOverride : null;
  const lastAt = override
    ? (override.lastMessageAt ?? null)
    : (row.state?.lastMessageAt ?? null);
  const lastPreview = override
    ? (override.lastMessagePreview ?? null)
    : (row.state?.lastMessagePreview ?? null);
  const lastMessageMine =
    !override && row.state?.lastMessageSenderId === viewerId;
  // Hex ObjectIds of one length compare in creation order: the partner has read up to our last message.
  const peerPointer = row.peerMember?.[0]?.lastReadMessageId ?? null;
  const readByPeer =
    isPrivate &&
    !!peerPointer &&
    !!row.state?.lastMessageId &&
    peerPointer >= row.state.lastMessageId;
  // Everything up to `hiddenAt` is hidden for this member, so a last message
  // at or before it isn't theirs to preview (or to count as unread).
  const historyCleared = Boolean(
    lastAt && row.hiddenAt && new Date(lastAt) <= new Date(row.hiddenAt),
  );
  return {
    channelId: row.channelId,
    type: row.chat.type,
    name: isPrivate ? "" : (row.chat.name ?? ""),
    description: isPrivate ? null : (row.chat.description ?? null),
    isPublic: !isPrivate && !!row.chat.isPublic,
    image: row.chat.image ?? [],
    signature: row.chat.type === ChatType.CHANNEL && !!row.chat.signature,
    link: row.chat.link ?? null,
    myRole: row.role as ChannelSummaryDto["myRole"],
    myPermissions: effectivePermissions(row.chat, row),
    isPinned: row.isPinned ?? false,
    isMuted: row.isMuted ?? false,
    lastReadMessageId: row.lastReadMessageId ?? null,
    lastMessageAt: lastAt,
    lastMessagePreview: historyCleared ? null : lastPreview,
    lastMessageMine,
    lastMessageRead: lastMessageMine ? readByPeer : null,
    historyCleared,
    memberCount: isPrivate ? undefined : (row.state?.memberCount ?? 0),
    tags: row.chat.tags ?? [],
    // Same definition as the folder `onlyUnread` filter's own match stage
    // just above in this same aggregation (`row.lastReadAt`/`state.lastMessageAt`
    // are both already sitting on this row for that reason) — kept in sync
    // deliberately rather than duplicating the boolean logic elsewhere.
    unread: Boolean(
      !historyCleared && lastAt && (!row.lastReadAt || row.lastReadAt < lastAt),
    ),
    otherUser:
      isPrivate && row.otherUser ? view.publicUser(row.otherUser) : undefined,
  };
}
