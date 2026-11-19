import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { GiphyService } from "src/giphy/giphy.service";
import { buildMediaUrl } from "src/media/media-url.util";
import { Request } from "express";

/**
 * The global, third-party-backed sticker tab only (B9). User-created sticker packs moved to
 * sticker-pack.controller.ts (`/v1/sticker-packs`) and sticker-use.controller.ts
 * (`/v1/stickers/:id/use`).
 */
@ApiTags("Stickers")
@Controller("stickers")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class StickerController {
  constructor(private readonly giphyService: GiphyService) {}

  @Get("giphy/search")
  @ApiOperation({
    summary: "Search Giphy's global sticker library",
    description:
      "Results not yet sent by anyone are served from Giphy directly; already-used ones are " +
      "flagged as cached (served from our own storage once actually sent).",
  })
  @ApiQuery({ name: "q", required: true })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  searchGiphy(
    @Query("q") q: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.giphyService.search(
      "sticker",
      q,
      Math.min(Math.max(Number(limit) || 24, 1), 50),
      Math.max(Number(offset) || 0, 0),
    );
  }

  @Get("giphy/trending")
  @ApiOperation({ summary: "Trending stickers from Giphy" })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  trendingGiphy(
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.giphyService.trending(
      "sticker",
      Math.min(Math.max(Number(limit) || 24, 1), 50),
      Math.max(Number(offset) || 0, 0),
    );
  }

  @Post("giphy/:giphyId/use")
  @ApiOperation({
    summary:
      "Use a Giphy sticker (mirrors it into our own storage on first use)",
    description:
      "First use downloads the sticker from Giphy and saves it to our MediaService storage; " +
      "every later use of the same Giphy id is served from there, no Giphy call needed.",
  })
  @ApiParam({ name: "giphyId" })
  async useGiphySticker(
    @Param("giphyId") giphyId: string,
    @Req() req: Request & { user: JWTPayload },
  ) {
    const result = await this.giphyService.useGiphyAsset(
      "sticker",
      giphyId,
      req.user.userId,
    );
    return {
      url: buildMediaUrl(req, `/uploads/media/${result.relativePath}`),
      title: result.title,
    };
  }
}
