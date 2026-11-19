import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { SearchService } from "./search.service";
import { SearchScope } from "./search-scope.enum";

@ApiTags("Search (v1)")
@Controller({ path: "search", version: "1" })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseFilters(AllExceptionsFilter)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  // "All" fires one request per scope (3) per debounced query.
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @ApiOperation({
    summary: "Unified search: people, channels, or messages",
    description:
      "People: username/name only, never email/phone. Channels: groups/channels only, " +
      "never private DMs. Messages: only across the caller's own channels.",
  })
  @ApiQuery({ name: "q", required: true, description: "Min length 2" })
  @ApiQuery({ name: "scope", required: true, enum: SearchScope })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  @ApiResponse({ status: 200 })
  search(
    @Query("q") q: string,
    @Query("scope") scope: string,
    @Req() req: { user: JWTPayload },
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    if (!(Object.values(SearchScope) as string[]).includes(scope)) {
      throw new BadRequestException(
        `scope must be one of: ${Object.values(SearchScope).join(", ")}`,
      );
    }
    const validScope = scope as SearchScope;
    const safeLimit = limit ? Number(limit) : undefined;
    const safeOffset = offset ? Number(offset) : undefined;
    switch (validScope) {
      case SearchScope.PEOPLE:
        return this.searchService.search(
          SearchScope.PEOPLE,
          q,
          req.user.userId,
          safeLimit,
          safeOffset,
        );
      case SearchScope.CHANNELS:
        return this.searchService.search(
          SearchScope.CHANNELS,
          q,
          req.user.userId,
          safeLimit,
          safeOffset,
        );
      case SearchScope.MESSAGES:
        return this.searchService.search(
          SearchScope.MESSAGES,
          q,
          req.user.userId,
          safeLimit,
          safeOffset,
        );
    }
  }
}
