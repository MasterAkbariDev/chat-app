import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { GiphyService } from "src/giphy/giphy.service";
import { buildMediaUrl } from "src/media/media-url.util";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { Request } from "express";

/**
 * The global, third-party-backed GIF tab only (B9). Personal clips — recording/uploading a
 * short video and converting it to a looping GIF for your own library — moved to
 * src/clips/ (`GET/POST/DELETE /v1/clips`), backed by `MediaService` like every other upload,
 * instead of this module's own parallel dedupe/storage pipeline.
 */
@ApiTags("GIFs")
@Controller("gifs")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class GifController {
  constructor(private readonly giphyService: GiphyService) {}

  @Get("giphy/search")
  @ApiOperation({
    summary: "Search Giphy's global GIF library",
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
      "gif",
      q,
      Math.min(Math.max(Number(limit) || 24, 1), 50),
      Math.max(Number(offset) || 0, 0),
    );
  }

  @Get("giphy/trending")
  @ApiOperation({ summary: "Trending GIFs from Giphy" })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  trendingGiphy(
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.giphyService.trending(
      "gif",
      Math.min(Math.max(Number(limit) || 24, 1), 50),
      Math.max(Number(offset) || 0, 0),
    );
  }

  @Post("giphy/:giphyId/use")
  @ApiOperation({
    summary: "Use a Giphy GIF (mirrors it into our own storage on first use)",
    description:
      "First use downloads the GIF from Giphy and saves it to our MediaService storage; every " +
      "later use of the same Giphy id is served from there, no Giphy call needed.",
  })
  @ApiParam({ name: "giphyId" })
  async useGiphyGif(
    @Param("giphyId") giphyId: string,
    @Req() req: Request & { user: JWTPayload },
  ) {
    const result = await this.giphyService.useGiphyAsset(
      "gif",
      giphyId,
      req.user.userId,
    );
    return {
      url: buildMediaUrl(req, `/uploads/media/${result.relativePath}`),
      title: result.title,
    };
  }
}
