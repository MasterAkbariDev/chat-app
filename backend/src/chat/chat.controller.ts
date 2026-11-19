import {
  Put,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";
import { ChatService } from "./chat.service";
import { CreateChatDto } from "./dto/create-chat.dto";
import { AddMembersDto } from "./dto/add-members.dto";
import { JWTPayload } from "src/interface/base.interface";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { UpdateChatDto } from "./dto/update-chat.dto";
import { AdminRightsDto, MemberPermissionsDto } from "./dto/permissions.dto";
import { ChatGateway } from "src/gateway/chat.gateway";
import { Throttle } from "@nestjs/throttler";

@ApiTags("Chats")
@Controller("chats")
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Post("create")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a chat/channel" })
  @ApiBody({ type: CreateChatDto })
  create(
    @Body() createChatDto: CreateChatDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.create(createChatDto, req.user.userId);
  }

  @Post("update/:channelId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update a chat" })
  @ApiParam({ name: "channelId", required: true })
  update(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Body() updateChatDto: UpdateChatDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.update(channelId, updateChatDto, req.user.userId);
  }

  @Post("subscribe")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Join a chat" })
  subscribe(
    @Query("channelId") channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.subscribe(channelId, req.user.userId);
  }

  @Post("unsubscribe")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Leave a chat" })
  unsubscribe(
    @Query("channelId") channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.unsubscribe(channelId, req.user.userId);
  }

  @Post(":channelId/members")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Add members to a group/channel (admin/owner only)",
    description:
      "There was previously no way to do this — the frontend's add-members step created DM " +
      "chats instead. Returns which ids were actually added vs. skipped (already a member, or banned).",
  })
  @ApiParam({ name: "channelId", required: true })
  @ApiBody({ type: AddMembersDto })
  addMembers(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Body() dto: AddMembersDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.addMembers(channelId, dto.userIds, req.user.userId);
  }

  @Get("my-chats")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get user's joined chats (with pin/mute state)" })
  getMyChats(@Req() req: { user: JWTPayload }) {
    return this.chatService.findUserJoinedChatsWithDisplay(req.user.userId);
  }

  @Get("saved-messages")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get or create the user's Saved Messages chat",
    description:
      "Every user has exactly one Saved Messages chat; created on first access.",
  })
  getSavedMessages(@Req() req: { user: JWTPayload }) {
    return this.chatService.findOrCreateSavedMessages(req.user.userId);
  }

  @Get("direct/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get or create a direct (1:1) chat with another user",
  })
  @ApiParam({ name: "userId", required: true })
  async getOrCreateDirect(
    @Param("userId") userId: string,
    @Req() req: { user: JWTPayload },
  ) {
    const chat = await this.chatService.findOrCreatePrivateChat(
      req.user.userId,
      userId,
    );
    const plain =
      typeof (chat as { toObject?: () => unknown }).toObject === "function"
        ? (chat as { toObject: () => unknown }).toObject()
        : chat;
    try {
      await this.chatGateway.notifyNewChat(userId, plain);
      await this.chatGateway.notifyNewChat(req.user.userId, plain);
    } catch (err) {
      console.error("notifyNewChat error:", err);
    }
    return plain;
  }

  @Get("common/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Groups you and another user are both in" })
  @ApiParam({ name: "userId", required: true })
  getCommonGroups(
    @Param("userId", ParseObjectIdPipe) userId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.commonGroups(req.user.userId, userId);
  }

  @Post(":channelId/clear-history")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Clear a chat's history for yourself",
    description:
      "Hides every message sent so far from you only; the chat stays in your list.",
  })
  @ApiParam({ name: "channelId", required: true })
  clearHistory(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.clearHistory(channelId, req.user.userId);
  }

  /* ─── Pin / Unpin chat ─── */
  @Post(":channelId/pin")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Pin a chat to the top of the list" })
  @ApiParam({ name: "channelId", required: true })
  pinChat(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setPinned(channelId, req.user.userId, true);
  }

  @Delete(":channelId/pin")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Unpin a chat" })
  @ApiParam({ name: "channelId", required: true })
  unpinChat(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setPinned(channelId, req.user.userId, false);
  }

  /* ─── Mute / Unmute chat ─── */
  @Post(":channelId/mute")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mute a chat" })
  @ApiParam({ name: "channelId", required: true })
  muteChat(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setMuted(channelId, req.user.userId, true);
  }

  @Delete(":channelId/mute")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Unmute a chat" })
  @ApiParam({ name: "channelId", required: true })
  unmuteChat(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setMuted(channelId, req.user.userId, false);
  }

  /* ─── Rights and permissions ─── */
  @Get(":channelId/permissions")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Your effective rights here, and the chat's default member permissions",
  })
  getPermissions(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.getPermissions(channelId, req.user.userId);
  }

  @Put(":channelId/permissions")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Groups: set what members may do by default (needs 'ban users')",
  })
  setDefaultPermissions(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Body() body: MemberPermissionsDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setDefaultPermissions(
      channelId,
      req.user.userId,
      body,
    );
  }

  @Put(":channelId/members/:userId/permissions")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Groups: per-person exceptions for a member (needs 'ban users')",
  })
  setMemberPermissions(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Param("userId", ParseObjectIdPipe) targetUserId: string,
    @Body() body: MemberPermissionsDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setMemberPermissions(
      channelId,
      targetUserId,
      req.user.userId,
      body,
    );
  }

  @Delete(":channelId/members/:userId/permissions")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Groups: clear a member's exceptions (back to the chat defaults)",
  })
  clearMemberPermissions(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Param("userId", ParseObjectIdPipe) targetUserId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setMemberPermissions(
      channelId,
      targetUserId,
      req.user.userId,
      null,
    );
  }

  @Put(":channelId/admins/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Make someone an admin with these rights, or change an admin's rights",
  })
  setAdminRights(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Param("userId", ParseObjectIdPipe) targetUserId: string,
    @Body() body: AdminRightsDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setAdminRights(
      channelId,
      targetUserId,
      req.user.userId,
      body,
    );
  }

  @Post(":channelId/admins/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Make a member an admin with default rights" })
  makeAdmin(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Param("userId", ParseObjectIdPipe) targetUserId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setAdmin(
      channelId,
      targetUserId,
      req.user.userId,
      true,
    );
  }

  @Delete(":channelId/admins/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Remove a member's admin role" })
  removeAdmin(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Param("userId", ParseObjectIdPipe) targetUserId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setAdmin(
      channelId,
      targetUserId,
      req.user.userId,
      false,
    );
  }

  /* ─── Invite links ─── */
  @Get(":channelId/invite")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the chat's invite link code (owner/admin)" })
  getInvite(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.getInviteCode(channelId, req.user.userId);
  }

  @Post(":channelId/invite/reset")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Replace the invite link (the old one stops working)",
  })
  resetInvite(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.getInviteCode(channelId, req.user.userId, true);
  }

  @Get("invite/:inviteCode")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Preview the chat behind an invite link" })
  previewInvite(
    @Param("inviteCode") inviteCode: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.previewInvite(inviteCode, req.user.userId);
  }

  @Post("invite/:inviteCode/join")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Join a group/channel through its invite link" })
  joinByInvite(
    @Param("inviteCode") inviteCode: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.joinByInvite(inviteCode, req.user.userId);
  }

  /* ─── Ban / Unban user ─── */
  @Get(":channelId/banned")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get banned user list (admin/owner only)" })
  @ApiParam({ name: "channelId", required: true })
  getBannedList(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.getBannedList(channelId, req.user.userId);
  }

  @Post(":channelId/ban/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Ban a user from a chat (admin only)" })
  @ApiParam({ name: "channelId", required: true })
  @ApiParam({ name: "userId", required: true })
  banUser(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Param("userId") targetUserId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setBanned(
      channelId,
      targetUserId,
      req.user.userId,
      true,
    );
  }

  @Delete(":channelId/ban/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Unban a user from a chat (admin only)" })
  @ApiParam({ name: "channelId", required: true })
  @ApiParam({ name: "userId", required: true })
  unbanUser(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Param("userId") targetUserId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setBanned(
      channelId,
      targetUserId,
      req.user.userId,
      false,
    );
  }

  @Post(":channelId/mute-member/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mute a member in a group (admin only)" })
  @ApiParam({ name: "channelId", required: true })
  @ApiParam({ name: "userId", required: true })
  muteMember(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Param("userId") targetUserId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setMutedByAdmin(
      channelId,
      targetUserId,
      req.user.userId,
      true,
    );
  }

  @Delete(":channelId/mute-member/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Unmute a member in a group (admin only)" })
  @ApiParam({ name: "channelId", required: true })
  @ApiParam({ name: "userId", required: true })
  unmuteMember(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Param("userId") targetUserId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setMutedByAdmin(
      channelId,
      targetUserId,
      req.user.userId,
      false,
    );
  }

  @Get(":channelId/participants")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "List chat participants for mention autocomplete (any member)",
  })
  @ApiParam({ name: "channelId", required: true })
  getParticipants(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.getParticipants(channelId, req.user.userId);
  }

  @Get(":channelId/members")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "List chat members for management (admin/owner only)",
  })
  @ApiParam({ name: "channelId", required: true })
  getMembersForManagement(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.getMembersForManagement(channelId, req.user.userId);
  }

  /* ─── Tags ─── */
  @Post(":channelId/tags")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Set tags for a chat" })
  @ApiParam({ name: "channelId", required: true })
  @ApiBody({
    schema: {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    },
  })
  setTags(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Body("tags") tags: string[],
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.setTags(channelId, tags, req.user.userId);
  }

  @Get("search")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: "Search channels" })
  searchChannels(
    @Query("q") query: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.chatService.findChat(
      query,
      Math.min(Number(limit) || 10, 100),
      Math.max(Number(offset) || 0, 0),
    );
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List/search chats" })
  findChat(
    @Query("keyword") keyword?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.chatService.findChat(
      keyword,
      Math.min(Number(limit) || 10, 100),
      Math.max(Number(offset) || 0, 0),
    );
  }

  @Get("link")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Resolve a chat by its invite link" })
  @ApiQuery({ name: "link", required: true })
  findChatByLink(@Query("link") link: string) {
    return this.chatService.findChatByLink(link);
  }

  @Get("preview/:channelId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Preview a chat before joining",
    description:
      "Narrow, non-member-only fields — no banned list, no messages.",
  })
  @ApiParam({ name: "channelId", required: true })
  getPreview(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.findChatByIdForPreview(channelId, req.user.userId);
  }

  @Get(":channelId/display")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get a chat's display name",
    description:
      "For a private (DM) chat this is the other member's name; for group/channel it's the chat's own name.",
  })
  @ApiParam({ name: "channelId", required: true })
  getDisplayName(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService
      .getChatDisplayName(channelId, req.user.userId)
      .then(displayName => ({ displayName }));
  }

  @Delete("delete/:channelId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete a chat (owner only)" })
  @ApiParam({ name: "channelId", required: true })
  delete(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.chatService.delete(channelId, req.user.userId ?? "");
  }
}
