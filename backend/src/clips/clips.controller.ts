import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { ClipsService } from "./clips.service";

/** Short clips only — MAX_DURATION_SEC in gif-conversion.service.ts trims to 10s regardless. */
const CLIP_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

@ApiTags("Clips")
@Controller({ path: "clips", version: "1" })
@UseGuards(JwtAuthGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class ClipsController {
  constructor(private readonly clipsService: ClipsService) {}

  @Get()
  @ApiOperation({ summary: "List your personal GIF clip library" })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  list(
    @Req() req: { user: JWTPayload },
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const offsetNum = Math.max(Number(offset) || 0, 0);
    return this.clipsService.list(req.user.userId, limitNum, offsetNum);
  }

  @Post()
  @ApiOperation({
    summary:
      "Add a GIF (or a video clip, converted to a looping GIF) to your library",
    description:
      "Accepts a GIF (stored as-is) or a short video (converted to GIF on the server), and saves it to your personal " +
      "library (stored via MediaService — deduped by content hash like any other upload).",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        title: { type: "string" },
      },
    },
  })
  @ApiResponse({ status: 201, description: "Clip saved." })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: CLIP_UPLOAD_MAX_BYTES },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: { user: JWTPayload },
    @Body("title") title?: string,
  ) {
    return this.clipsService.upload(file, req.user.userId, title);
  }

  @Post("from-message/:messageId")
  @ApiOperation({
    summary: "Save a GIF message to your library",
    description:
      "Re-uses the media already stored for that message (no re-download). You must be able " +
      "to see the message. Saving one you already have just bumps it to the top.",
  })
  @ApiParam({ name: "messageId" })
  @ApiResponse({ status: 201, description: "Clip saved." })
  saveFromMessage(
    @Param("messageId") messageId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.clipsService.saveFromMessage(messageId, req.user.userId);
  }

  @Post(":clipId/use")
  @ApiOperation({
    summary: "Record a clip use (bumps last-used and usage count)",
  })
  @ApiParam({ name: "clipId" })
  use(@Param("clipId") clipId: string, @Req() req: { user: JWTPayload }) {
    return this.clipsService.use(clipId, req.user.userId);
  }

  @Delete(":clipId")
  @ApiOperation({ summary: "Remove a clip from your library" })
  @ApiParam({ name: "clipId" })
  remove(@Param("clipId") clipId: string, @Req() req: { user: JWTPayload }) {
    return this.clipsService.remove(clipId, req.user.userId);
  }
}
