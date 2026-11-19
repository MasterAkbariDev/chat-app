import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  Version,
} from "@nestjs/common";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";
import { MessageService } from "./message.service";
import { MessageInfoService } from "./message-info.service";
import { CreateMessageDto } from "./dto/create-message.dto";
import { UpdateMessageDto } from "./dto/update-message.dto";
import { JWTPayload } from "src/interface/base.interface";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { ChatGateway } from "src/gateway/chat.gateway";
import { Throttle } from "@nestjs/throttler";
import { isSharedMediaKind, SHARED_MEDIA_KINDS } from "./shared-media.util";

@ApiTags("Messages")
@Controller("messages")
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly chatGateway: ChatGateway,
    private readonly messageInfoService: MessageInfoService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Send a message",
    description:
      "Sends a new message to a channel. User must be a member. Supports text, image, file, gif, sticker, voice, video.",
  })
  @ApiBody({ type: CreateMessageDto })
  @ApiResponse({ status: 201, description: "Message sent successfully." })
  @ApiResponse({ status: 403, description: "Access denied." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  async create(
    @Body() createMessageDto: CreateMessageDto,
    @Req() req: { user: JWTPayload },
  ) {
    const message = await this.messageService.create(
      createMessageDto,
      req.user.userId,
    );
    // Architecture Rule #16 fix (B12): the WS `send_message` path broadcasts to the
    // channel room itself; this REST path previously created the message and returned
    // silently, so anyone connected only via socket never saw it until their next fetch.
    this.chatGateway.broadcastNewMessage(message.channelId, message);
    return message;
  }

  @Get("channel/:channelId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get messages from a channel",
    description:
      "Returns paginated messages from a channel. User must be a member.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Max results (default 100, max 100)",
  })
  @ApiQuery({
    name: "offset",
    required: false,
    description: "Skip count (default 0)",
  })
  @ApiQuery({
    name: "afterDate",
    required: false,
    description:
      "ISO date string - only messages created at or after this date",
  })
  @ApiQuery({
    name: "beforeDate",
    required: false,
    description: "ISO date string - only messages created before this date",
  })
  @ApiQuery({
    name: "direction",
    required: false,
    description:
      '"older" (default): the newest `limit` messages in range. "newer": the oldest ones — ' +
      "page forward from `afterDate`. Either way the page comes back oldest-first.",
  })
  @ApiResponse({ status: 200, description: "List of messages." })
  @ApiResponse({ status: 403, description: "Access denied." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  findAll(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("afterDate") afterDate?: string,
    @Query("beforeDate") beforeDate?: string,
    @Query("direction") direction?: string,
  ) {
    const limitNum = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const offsetNum = Math.max(Number(offset) || 0, 0);
    return this.messageService.findAll(
      channelId,
      req.user.userId,
      limitNum,
      offsetNum,
      afterDate,
      beforeDate,
      direction === "newer" ? "newer" : "older",
    );
  }

  @Get("channel/:channelId/first-of-date")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get first message of a calendar day",
    description:
      "Returns the earliest message on the given date (YYYY-MM-DD), or null if none.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiQuery({
    name: "date",
    required: true,
    description: "Date in YYYY-MM-DD format",
  })
  @ApiResponse({
    status: 200,
    description: "{ messageId: string | null }",
  })
  @ApiResponse({ status: 403, description: "Access denied." })
  getFirstOfDate(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Query("date") date: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageService.getFirstMessageOfDate(
      channelId,
      req.user.userId,
      date,
    );
  }

  @Get("channel/:channelId/first-from-date")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get first message on or after a date",
    description:
      "Returns the earliest message at or after the given date (YYYY-MM-DD), or null if none. Used to jump to nearest forward date with messages.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiQuery({
    name: "date",
    required: true,
    description: "Date in YYYY-MM-DD format",
  })
  @ApiQuery({
    name: "from",
    required: false,
    description:
      "ISO instant — return the first message at or after it instead (the client's local start of the picked day).",
  })
  @ApiResponse({
    status: 200,
    description: "{ messageId: string | null, createdAt: string | null }",
  })
  getFirstFromDate(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Query("date") date: string,
    @Req() req: { user: JWTPayload },
    @Query("from") from?: string,
  ) {
    return this.messageService.getFirstMessageFromDate(
      channelId,
      req.user.userId,
      date,
      from,
    );
  }

  @Get("channel/:channelId/oldest")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get oldest message in channel",
    description:
      "Returns the earliest message in the channel (e.g. when selected date is before any message).",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiResponse({
    status: 200,
    description: "{ messageId: string | null, createdAt: string | null }",
  })
  getOldestMessage(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageService.getOldestMessageInChannel(
      channelId,
      req.user.userId,
    );
  }

  @Get("channel/:channelId/search")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Search messages in a channel",
    description:
      "Search by keyword (content) or @ for messages mentioning the current user. Returns ordered message IDs for navigation.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiQuery({
    name: "q",
    required: true,
    description: "Search query; use '@' for messages mentioning you",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Max result IDs (default 500, max 500)",
  })
  @ApiResponse({
    status: 200,
    description: "{ messageIds: string[], total: number }",
  })
  searchInChannel(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Query("q") q: string,
    @Query("limit") limit?: string,
    @Req() req?: { user: JWTPayload },
  ) {
    const limitNum = Math.min(Math.max(Number(limit) || 500, 1), 500);
    return this.messageService.searchInChannel(
      channelId,
      req!.user.userId,
      q || "",
      limitNum,
    );
  }

  @Get("channel/:channelId/shared/counts")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Shared media counts",
    description:
      "How many items each shared-media tab (media, files, music, voice, links, gifs) holds — an album counts each photo/video, a file group each file.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  getSharedCounts(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageService.getSharedCounts(channelId, req.user.userId);
  }

  @Get("channel/:channelId/shared/items")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Shared media items",
    description:
      "One shared-media tab as items (each photo/video of an album, each file of a group…), newest first: `items` ({messageId, index}) in order, the `messages` they come from, and `nextCursor` for the next page.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiQuery({ name: "kind", required: true, enum: SHARED_MEDIA_KINDS })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Items per page. Default 60, max 120",
  })
  getSharedItems(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
    @Query("kind") kind: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    if (!isSharedMediaKind(kind)) {
      throw new BadRequestException(
        `kind must be one of: ${SHARED_MEDIA_KINDS.join(", ")}`,
      );
    }
    const limitNum = Math.min(Math.max(Number(limit) || 60, 1), 120);
    return this.messageService.getSharedItems(
      channelId,
      req.user.userId,
      kind,
      cursor,
      limitNum,
    );
  }

  @Get("channel/:channelId/shared")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Shared media",
    description:
      "A chat's photos/videos, files, music, links or voice messages, newest first. Page with `before` (the oldest createdAt you have).",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiQuery({ name: "kind", required: true, enum: SHARED_MEDIA_KINDS })
  @ApiQuery({ name: "before", required: false })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Default 40, max 100",
  })
  getShared(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
    @Query("kind") kind: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ) {
    if (!isSharedMediaKind(kind)) {
      throw new BadRequestException(
        `kind must be one of: ${SHARED_MEDIA_KINDS.join(", ")}`,
      );
    }
    const limitNum = Math.min(Math.max(Number(limit) || 40, 1), 100);
    return this.messageService.getSharedMessages(
      channelId,
      req.user.userId,
      kind,
      before,
      limitNum,
    );
  }

  @Get("channel/:channelId/pinned")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get pinned messages",
    description: "Returns all pinned messages in a channel.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiResponse({ status: 200, description: "List of pinned messages." })
  @ApiResponse({ status: 403, description: "Access denied." })
  getPinnedMessages(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageService.getPinnedMessages(channelId, req.user.userId);
  }

  @Get("channel/:channelId/unread")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get unread message count",
    description:
      "Returns the number of messages in the channel that the user has not read (after their last read message).",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiResponse({ status: 200, description: "Unread count (number)." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  getUnreadCount(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageService.getUnreadCount(channelId, req.user.userId);
  }

  @Get("channel/:channelId/unread-reactions")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get unread reaction messages",
    description:
      "Returns messages in this channel with reactions that are after the user's last read message.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Max results (default 50, max 100)",
  })
  @ApiResponse({
    status: 200,
    description: "Unread reaction messages and total count.",
  })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  getUnreadReactions(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
    @Query("limit") limit?: string,
  ) {
    const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 100);
    return this.messageService.getUnreadReactions(
      channelId,
      req.user.userId,
      limitNum,
    );
  }

  @Get("channel/:channelId/unread-mentions")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get unread mention messages",
    description:
      "Returns messages in this channel where the current user was mentioned after their last read message, plus total count.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Max results (default 50, max 100)",
  })
  @ApiResponse({
    status: 200,
    description: "Unread mention messages and total count.",
  })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  getUnreadMentions(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
    @Query("limit") limit?: string,
  ) {
    const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 100);
    return this.messageService.getUnreadMentions(
      channelId,
      req.user.userId,
      limitNum,
    );
  }

  @Post("channel/:channelId/read")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Mark messages as read",
    description:
      "Marks messages in the channel as read up to the given message ID. Used for read receipts.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiBody({
    schema: {
      type: "object",
      properties: { lastReadMessageId: { type: "string" } },
      required: ["lastReadMessageId"],
    },
  })
  @ApiResponse({ status: 200, description: "Read receipt updated." })
  @ApiResponse({ status: 403, description: "Access denied." })
  @ApiResponse({ status: 404, description: "Message not found." })
  async markAsRead(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Body("lastReadMessageId") lastReadMessageId: string,
    @Req() req: { user: JWTPayload },
  ) {
    const result = await this.messageService.markAsRead(
      channelId,
      req.user.userId,
      lastReadMessageId,
    );
    this.chatGateway.notifyReadUpdated(channelId, {
      userId: req.user.userId,
      lastReadMessageId,
      upToCreatedAt: result.upToCreatedAt,
    });
    return result;
  }

  @Version("1")
  @Get("channel/:channelId/read-state")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "How far the other members have read",
    description:
      "`othersReadUpTo`: the createdAt of the newest message any other member has read (DMs " +
      "and groups; null for channels or when nobody has read anything). Your own messages " +
      "created at or before it are read (✓✓). `read:updated` events carry `upToCreatedAt` " +
      "to keep it live.",
  })
  @ApiParam({ name: "channelId", description: "Channel ID", required: true })
  @ApiResponse({
    status: 200,
    description: "{ chatType, othersReadUpTo: string | null }",
  })
  @ApiResponse({ status: 403, description: "Not a member." })
  getReadState(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageInfoService.getReadState(channelId, req.user.userId);
  }

  @Version("1")
  @Get(":messageId/reads")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "See who has read this message, and when",
    description:
      "Author-only. DMs and groups only — channels never expose read data. Read times are " +
      "kept for 7 days (`readAt: null` beyond that); groups over 100 members get the count " +
      "only (`hidden: true`).",
  })
  @ApiParam({ name: "messageId", description: "Message ID", required: true })
  @ApiResponse({
    status: 200,
    description:
      "{ messageId, chatType, readers: {user, readAt|null}[], total, eligible, kept, hidden, readBy }",
  })
  @ApiResponse({ status: 403, description: "Not the author." })
  getMessageReads(
    @Param("messageId", ParseObjectIdPipe) messageId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageInfoService.getReadInfo(messageId, req.user.userId);
  }

  @Version("1")
  @Get(":messageId/reactions")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "See who reacted to this message",
    description:
      "Any joined member; in channels only admins. Newest first, at most 500 rows.",
  })
  @ApiParam({ name: "messageId", description: "Message ID", required: true })
  @ApiResponse({
    status: 200,
    description:
      "{ messageId, total, reactions: {user, emoji, packItemId, relativePath, packId, reactedAt}[] }",
  })
  @ApiResponse({
    status: 403,
    description: "Not a member / not a channel admin.",
  })
  getMessageReactions(
    @Param("messageId", ParseObjectIdPipe) messageId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageInfoService.getReactionList(messageId, req.user.userId);
  }

  @Get(":messageId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get a single message",
    description:
      "Returns a single message by ID. User must be a member of the channel.",
  })
  @ApiParam({ name: "messageId", description: "Message ID", required: true })
  @ApiResponse({ status: 200, description: "Message found." })
  @ApiResponse({ status: 404, description: "Message not found." })
  @ApiResponse({ status: 403, description: "Access denied." })
  findOne(
    @Param("messageId", ParseObjectIdPipe) messageId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageService.findOne(messageId, req.user.userId);
  }

  @Put(":messageId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Edit a message",
    description:
      "Updates a message. Only the sender can edit their own messages.",
  })
  @ApiParam({ name: "messageId", description: "Message ID", required: true })
  @ApiBody({ type: UpdateMessageDto })
  @ApiResponse({ status: 200, description: "Message updated successfully." })
  @ApiResponse({
    status: 403,
    description: "Not allowed to edit this message.",
  })
  @ApiResponse({ status: 404, description: "Message not found." })
  async update(
    @Param("messageId", ParseObjectIdPipe) messageId: string,
    @Body() updateMessageDto: UpdateMessageDto,
    @Req() req: { user: JWTPayload },
  ) {
    const updated = await this.messageService.update(
      messageId,
      updateMessageDto,
      req.user.userId,
    );
    if (updated?.channelId) {
      this.chatGateway.notifyMessageUpdated(updated.channelId, updated);
    }
    return updated;
  }

  @Post(":messageId/reaction")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Add or remove reaction",
    description:
      "Adds or removes a reaction to a message. Toggle behavior. Provide exactly one of " +
      "`emoji` (a plain unicode emoji) or `packItemId` (a sticker/animated-emoji pack item — " +
      "the caller must already have that pack, same rule as sending one; it's authorized and " +
      "its usage bumped server-side). To send a 'quick reaction', the client passes the " +
      "user's own `quickReaction` value as `emoji` here — there is no separate quick-reaction " +
      "endpoint (B5).",
  })
  @ApiParam({ name: "messageId", description: "Message ID", required: true })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        emoji: {
          type: "string",
          description: "Provide this OR packItemId, not both",
        },
        packItemId: {
          type: "string",
          description: "Provide this OR emoji, not both",
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      "{ channelId, messageId, emoji, packItemId, action, reactions }",
  })
  @ApiResponse({ status: 404, description: "Message not found." })
  async toggleReaction(
    @Param("messageId", ParseObjectIdPipe) messageId: string,
    @Body("emoji") emoji: string | undefined,
    @Body("packItemId") packItemId: string | undefined,
    @Req() req: { user: JWTPayload },
  ) {
    const result = await this.messageService.toggleReaction(
      messageId,
      req.user.userId,
      emoji,
      packItemId,
    );
    const summary = result.reactions.find(
      r => r.emoji === result.emoji && r.packItemId === result.packItemId,
    );
    this.chatGateway.notifyReactionChanged(result.channelId, {
      messageId: result.messageId,
      emoji: result.emoji,
      packItemId: result.packItemId,
      relativePath: summary?.relativePath ?? null,
      packId: summary?.packId ?? null,
      userId: result.userId,
      action: result.action,
    });
    return result;
  }

  @Post(":messageId/pin")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Pin a message",
    description: "Pins a message in a channel. Only admins/owners can pin.",
  })
  @ApiParam({ name: "messageId", description: "Message ID", required: true })
  @ApiResponse({ status: 200, description: "Message pinned." })
  @ApiResponse({ status: 403, description: "Not allowed." })
  pinMessage(
    @Param("messageId", ParseObjectIdPipe) messageId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageService.pinMessage(messageId, req.user.userId);
  }

  @Delete(":messageId/pin")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Unpin a message",
    description: "Unpins a message. Only admins/owners can unpin.",
  })
  @ApiParam({ name: "messageId", description: "Message ID", required: true })
  @ApiResponse({ status: 200, description: "Message unpinned." })
  @ApiResponse({ status: 403, description: "Not allowed." })
  unpinMessage(
    @Param("messageId", ParseObjectIdPipe) messageId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageService.unpinMessage(messageId, req.user.userId);
  }

  @Delete(":messageId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Delete a message",
    description:
      "Soft-deletes a message for everyone. Sender, admins, and owners can delete.",
  })
  @ApiParam({ name: "messageId", description: "Message ID", required: true })
  @ApiResponse({ status: 200, description: "Message deleted successfully." })
  @ApiResponse({
    status: 403,
    description: "Not allowed to delete this message.",
  })
  @ApiResponse({ status: 404, description: "Message not found." })
  async remove(
    @Param("messageId", ParseObjectIdPipe) messageId: string,
    @Req() req: { user: JWTPayload },
  ) {
    const updated = await this.messageService.remove(
      messageId,
      req.user.userId,
    );
    const channelId = updated?.channelId?.toString?.();
    if (channelId) {
      this.chatGateway.notifyMessageDeleted(
        channelId,
        messageId,
        await this.messageService.channelLastState(channelId),
      );
    }
    return updated;
  }

  @Post(":messageId/delete-for-me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Delete message for me only",
    description:
      "Hides the message only for the current user. Other participants still see it. Used in private chats.",
  })
  @ApiParam({ name: "messageId", description: "Message ID", required: true })
  @ApiResponse({ status: 200, description: "Message hidden for you." })
  @ApiResponse({ status: 404, description: "Message not found." })
  removeForMeOnly(
    @Param("messageId", ParseObjectIdPipe) messageId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.messageService.removeForMeOnly(messageId, req.user.userId);
  }
}
