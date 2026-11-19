import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  Patch,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { UserService } from "./user.service";
import { UpdateUserDto } from "./dto/update-user.dto";
import { AddPhotoDto } from "./dto/add-photo.dto";
import { AddRecentEmojiDto } from "./dto/add-recent-emoji.dto";
import { UpdatePrivacyDto } from "./dto/update-privacy.dto";
import { AddMembersDto } from "src/chat/dto/add-members.dto";
import { PeopleDiscoveryService } from "./people-discovery.service";
import { PrivacySettingsDto } from "src/common/dto/user-view.dto";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JWTPayload } from "src/interface/base.interface";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { ChatGateway } from "src/gateway/chat.gateway";
@ApiTags("Users")
@Controller("users")
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly chatGateway: ChatGateway,
    private readonly discovery: PeopleDiscoveryService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Update current user",
    description:
      "Updates the authenticated user's profile. Send only fields you want to change. Use POST /auth/change-password to change password.",
  })
  @ApiBody({ type: UpdateUserDto })
  @ApiResponse({ status: 200, description: "User updated successfully." })
  @ApiResponse({ status: 400, description: "Bad request." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  @ApiResponse({ status: 404, description: "User not found." })
  update(
    @Body() updateUserDto: UpdateUserDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.userService.update(req.user.userId, updateUserDto);
  }

  @Get("search")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Search users",
    description:
      "Same rules as GET /v1/search?scope=people: names only match people you already know " +
      "(contacts, shared chats); strangers only by @username (≥4 chars = prefix, else exact) " +
      "and only if their privacy allows it. Never email/phone.",
  })
  @ApiQuery({ name: "q", description: "Search query", required: true })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Max results (default 20)",
  })
  @ApiQuery({
    name: "offset",
    required: false,
    description: "Skip count (default 0)",
  })
  @ApiResponse({ status: 200, description: "List of matching users." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  searchUsers(
    @Req() req: { user: JWTPayload },
    @Query("q") query: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const offsetNum = Math.min(Math.max(Number(offset) || 0, 0), 500);
    const q = String(query ?? "")
      .trim()
      .slice(0, 100);
    if (!q) return [];
    return this.discovery.searchPeople(q, req.user.userId, limitNum, offsetNum);
  }

  @Get("privacy")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "My privacy settings with their exceptions",
    description:
      "Each setting: { audience: everybody|contacts|nobody, allow: users always allowed, " +
      "deny: users never allowed }. 'contacts' = people I saved as contacts.",
  })
  getPrivacy(@Req() req: { user: JWTPayload }) {
    return this.userService.getPrivacy(req.user.userId);
  }

  @Patch("privacy")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Update my privacy settings",
    description:
      "Send only the settings to change. Each value is an audience string, or " +
      "{ audience?, allow?: userId[], deny?: userId[] } (a list replaces the stored one; " +
      "someone added to one list leaves the other). Settings: phoneNumber (default contacts), " +
      "email (nobody), lastSeen, profilePhotos, bio, calls, groupInvites, forwards (everybody), " +
      "findByUsername (everybody), findByPhoneOrEmail (contacts). Returns all settings.",
  })
  @ApiBody({ type: UpdatePrivacyDto })
  @ApiResponse({ status: 200, type: PrivacySettingsDto })
  updatePrivacy(
    @Body() body: UpdatePrivacyDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.userService.updatePrivacy(
      req.user.userId,
      body as Record<string, unknown>,
    );
  }

  @Post("addable")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Which of these people won't let me add them to groups/channels",
    description:
      "For the add-members picker: `restricted` = ids whose 'Groups & channels' privacy " +
      "doesn't allow you (adding them would be skipped).",
  })
  @ApiBody({ type: AddMembersDto })
  async addable(@Body() body: AddMembersDto, @Req() req: { user: JWTPayload }) {
    return {
      restricted: await this.userService.restrictedForGroupInvites(
        req.user.userId,
        body.userIds,
      ),
    };
  }

  @Get("by-id/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get user by ID",
    description:
      "Returns a single user by their _id. Use for finding users by shareable user ID.",
  })
  @ApiParam({ name: "userId", description: "User ID (_id)", required: true })
  @ApiResponse({ status: 200, description: "User found." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  @ApiResponse({ status: 404, description: "User not found." })
  @ApiResponse({ status: 403, description: "Access denied (blocked)." })
  async getById(
    @Param("userId") userId: string,
    @Req() req: { user: JWTPayload },
  ) {
    // If the requested user has blocked the requester, do not expose profile.
    if (userId !== req.user.userId) {
      const blocked = await this.userService.isBlocked(userId, req.user.userId);
      if (blocked) {
        throw new ForbiddenException("Access denied");
      }
    }
    return this.userService.findOne(userId, req.user.userId);
  }

  @Get("blocked")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "List blocked user IDs",
    description: "Returns the list of user IDs the current user has blocked.",
  })
  @ApiResponse({ status: 200, description: "Array of blocked user IDs." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  getBlocked(@Req() req: { user: JWTPayload }) {
    return this.userService.getBlockedUserIds(req.user.userId);
  }

  @Get("block/check/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Check if a user has blocked you",
    description:
      "Returns whether the given user has blocked the current user (so they will not receive your messages).",
  })
  @ApiParam({ name: "userId", description: "User ID to check" })
  @ApiResponse({ status: 200, description: "{ blocked: boolean }" })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  async hasBlockedMe(
    @Param("userId") userId: string,
    @Req() req: { user: JWTPayload },
  ) {
    const blocked = await this.userService.isBlocked(userId, req.user.userId);
    return { blocked };
  }

  @Post("block/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Block a user",
    description:
      "Block a user by ID. When they message you in a DM, you will not receive the message.",
  })
  @ApiParam({ name: "userId", description: "User ID to block", required: true })
  @ApiResponse({ status: 201, description: "User blocked." })
  @ApiResponse({ status: 400, description: "Cannot block yourself." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  async blockUser(
    @Param("userId") userId: string,
    @Req() req: { user: JWTPayload },
  ) {
    const result = await this.userService.block(req.user.userId, userId);
    // Live for the blocked person: their open chat with you switches to "can't message" at once.
    this.chatGateway.emitToUser(userId, "user_blocked_you", {
      blockedBy: req.user.userId,
    });
    return result;
  }

  @Delete("block/:userId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Unblock a user",
    description: "Remove a user from your block list.",
  })
  @ApiParam({
    name: "userId",
    description: "User ID to unblock",
    required: true,
  })
  @ApiResponse({ status: 200, description: "User unblocked." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  async unblockUser(
    @Param("userId") userId: string,
    @Req() req: { user: JWTPayload },
  ) {
    await this.userService.unblock(req.user.userId, userId);
    this.chatGateway.emitToUser(userId, "user_unblocked_you", {
      unblockedBy: req.user.userId,
    });
  }

  @Get(":username")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get user by username",
    description:
      "Returns a single user by their username. Requires authentication.",
  })
  @ApiParam({
    name: "username",
    description: "Unique username",
    required: true,
  })
  @ApiResponse({ status: 200, description: "User found." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  @ApiResponse({
    status: 404,
    description:
      "No such user — or hidden by their privacy settings / a block (indistinguishable).",
  })
  async findOne(
    @Param("username") username: string,
    @Req() req: { user: JWTPayload },
  ) {
    const id = await this.discovery.resolveExact(req.user.userId, {
      username,
    });
    if (!id) throw new NotFoundException("User not found");
    return this.userService.findOne(id, req.user.userId);
  }

  /* ─── Profile photos (main first; everyone can browse them) ─── */
  @Get(":userId/photos")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "A user's profile photos and videos, main first",
    description: "Empty when their privacy hides their photos from you.",
  })
  listPhotos(
    @Param("userId", ParseObjectIdPipe) userId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.userService.listPhotosFor(userId, req.user.userId);
  }

  @Post("me/photos")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "Add a profile photo/video (main by default)" })
  addPhoto(@Body() body: AddPhotoDto, @Req() req: { user: JWTPayload }) {
    return this.userService.addPhoto(req.user.userId, body);
  }

  @Post("me/photos/:photoId/main")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Make one of your photos the main one" })
  setMainPhoto(
    @Param("photoId", ParseObjectIdPipe) photoId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.userService.setMainPhoto(req.user.userId, photoId);
  }

  @Delete("me/photos/:photoId")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete one of your profile photos" })
  deletePhoto(
    @Param("photoId", ParseObjectIdPipe) photoId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.userService.deletePhoto(req.user.userId, photoId);
  }

  @Get(":userId/status")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get user status",
    description:
      "Returns user's last seen timestamp. When their privacy hides it from you (or you hide " +
      "yours from them), isOnline is false, lastSeen null and lastSeenBucket is one of " +
      "recently | within_week | within_month | long_ago. Live updates: WebSocket.",
  })
  @ApiParam({ name: "userId", description: "User ID", required: true })
  @ApiResponse({ status: 200, description: "User status with lastSeen." })
  @ApiResponse({ status: 404, description: "User not found." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  async getUserStatus(
    @Param("userId") userId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.userService.getUserStatus(userId, req.user.userId);
  }

  @Delete(":id")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Delete current user",
    description:
      "Soft-deletes the authenticated user. The id in path must match the authenticated user's id.",
  })
  @ApiParam({
    name: "id",
    description: "User ID (must match authenticated user)",
    required: true,
  })
  @ApiResponse({ status: 200, description: "User deleted successfully." })
  @ApiResponse({ status: 400, description: "Not allowed or user not found." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  remove(@Param("id") id: string, @Req() req: { user: JWTPayload }) {
    return this.userService.remove(id, req.user.userId);
  }

  @Get("me/recent-emoji")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Your recent emoji (plain and animated), newest first, at most 30",
  })
  getRecentEmoji(@Req() req: { user: JWTPayload }) {
    return this.userService.getRecentEmoji(req.user.userId);
  }

  @Post("me/recent-emoji")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: "Record a picked emoji at the front of your recent list",
    description:
      "Send `emoji` for a plain emoji, or `packItemId` for an animated emoji (exactly one). " +
      "Returns the updated list.",
  })
  addRecentEmoji(
    @Body() body: AddRecentEmojiDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.userService.addRecentEmoji(req.user.userId, body);
  }

  @Patch("quick-reaction")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Set your quick (double-tap) reaction",
    description:
      "Send `emoji` for a plain emoji, or `packItemId` for an animated emoji from a pack you " +
      "own or have added (exactly one of the two).",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        emoji: { type: "string", example: "👍" },
        packItemId: { type: "string" },
      },
    },
  })
  @ApiResponse({ status: 200, description: "Updated successfully." })
  @ApiResponse({ status: 400, description: "Invalid emoji or item." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  @ApiResponse({ status: 403, description: "Pack not added." })
  updateQuickReaction(
    @Req() req: { user: JWTPayload },
    @Body("emoji") emoji?: string,
    @Body("packItemId") packItemId?: string,
  ) {
    return this.userService.updateQuickReaction(
      req.user.userId,
      typeof emoji === "string" ? emoji : undefined,
      typeof packItemId === "string" ? packItemId : undefined,
    );
  }

  @Patch("notifications")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Set my push-notification level",
    description:
      "all: every message. mentions: only when @mentioned. none: never push " +
      "(still delivered live over the socket if the app is open).",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["all", "mentions", "none"] },
      },
      required: ["level"],
    },
  })
  @ApiResponse({ status: 200, description: "{ success: true }" })
  setNotificationLevel(
    @Body("level") level: "all" | "mentions" | "none",
    @Req() req: { user: JWTPayload },
  ) {
    if (!["all", "mentions", "none"].includes(level)) {
      throw new BadRequestException(
        "level must be one of: all, mentions, none",
      );
    }
    return this.userService.setNotificationLevel(req.user.userId, level);
  }
}
