import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";
import { ChannelsService, ListMineResult } from "./channels.service";
import { SearchService } from "src/search/search.service";
import { ReorderPinsDto } from "./dto/reorder-pins.dto";

@ApiTags("Channels (v1)")
@Controller({ path: "channels", version: "1" })
@UseFilters(AllExceptionsFilter)
export class ChannelsController {
  constructor(
    private readonly channelsService: ChannelsService,
    private readonly searchService: SearchService,
  ) {}

  @Get("mine")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "List the caller's chats (one aggregation, cursor-paginated)",
    description:
      "Pinned chats are always included; the rest are keyset-paginated by chat_state.lastMessageAt. " +
      "Replaces the legacy GET /chats/my-chats's per-DM lookup with one aggregation.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Max non-pinned rows (default 30, max 100)",
  })
  @ApiQuery({
    name: "cursor",
    required: false,
    description: "Opaque cursor from a previous page's nextCursor",
  })
  @ApiQuery({
    name: "folder",
    required: false,
    description:
      "A folder id from GET /v1/folders — filters this page server-side",
  })
  @ApiResponse({
    status: 200,
    description: "{ items: ChannelSummaryDto[], nextCursor: string | null }",
  })
  async listMine(
    @Req() req: { user: JWTPayload },
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
    @Query("folder") folder?: string,
  ): Promise<ListMineResult> {
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.channelsService.listMine(req.user.userId, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      cursor: cursor ?? null,
      folderId: folder || undefined,
    });
  }

  @Put("mine/pins")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: "Reorder your pinned chats",
    description:
      "Sets the order of your pinned chats (top first). Ids that aren't pinned are ignored.",
  })
  @ApiResponse({ status: 200, description: "{ success: true }" })
  reorderPins(@Req() req: { user: JWTPayload }, @Body() body: ReorderPinsDto) {
    return this.channelsService.reorderPins(req.user.userId, body.channelIds);
  }

  @Get(":channelId/messages/search")
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Search messages in a channel (snippet + cursor windows)",
    description:
      "Replaces the legacy GET /messages/channel/:channelId/search's bare id array with " +
      "snippets and a cursor for pagination.",
  })
  @ApiParam({ name: "channelId", required: true })
  @ApiQuery({ name: "q", required: true, description: "Min length 2" })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiResponse({
    status: 200,
    description: "{ items: MessageSearchHit[], nextCursor: string | null }",
  })
  searchMessagesInChannel(
    @Param("channelId", ParseObjectIdPipe) channelId: string,
    @Query("q") q: string,
    @Req() req: { user: JWTPayload },
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.searchService.searchInChannel(
      channelId,
      req.user.userId,
      q,
      limit ? Number(limit) : undefined,
      cursor,
    );
  }
}
