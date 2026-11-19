import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
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
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { Request } from "express";
import { WallpaperService } from "./wallpaper.service";
import {
  AcceptWallpaperDto,
  ApplyWallpaperDto,
  UpdateWallpaperSettingsDto,
} from "./dto/wallpaper-settings.dto";
import {
  WALLPAPER_MAX_IMAGE_BYTES,
  WALLPAPER_MAX_VIDEO_BYTES,
} from "./wallpaper-media.service";

@ApiTags("Wallpapers v2")
@Controller("v2/wallpapers")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WallpaperController {
  constructor(private readonly wallpaperService: WallpaperService) {}

  @Post("upload/image")
  @ApiOperation({
    summary: "Upload wallpaper image",
    description:
      "Routed through MediaService — response includes mediaId " +
      "to pass back in the apply call so the nightly GC can track it.",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: WALLPAPER_MAX_IMAGE_BYTES },
    }),
  )
  async uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.wallpaperService.uploadImage(req.user.userId, file, req);
  }

  @Post("upload/video")
  @ApiOperation({
    summary: "Upload wallpaper video (silent loop; cut to the first 10 s)",
    description:
      "Routed through MediaService, which also compresses it and " +
      "extracts a poster frame — response includes mediaId (see upload/image).",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: WALLPAPER_MAX_VIDEO_BYTES },
    }),
  )
  async uploadVideo(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.wallpaperService.uploadVideo(req.user.userId, file, req);
  }

  @Get("global")
  @ApiOperation({ summary: "Get global wallpaper" })
  getGlobal(@Req() req: Request & { user: { userId: string } }) {
    return this.wallpaperService.getGlobal(req.user.userId);
  }

  @Patch("global")
  @ApiOperation({ summary: "Apply global wallpaper" })
  applyGlobal(
    @Body() dto: ApplyWallpaperDto,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.wallpaperService.applyGlobal(req.user.userId, dto);
  }

  @Delete("global")
  @ApiOperation({ summary: "Reset global wallpaper to default" })
  resetGlobal(@Req() req: Request & { user: { userId: string } }) {
    return this.wallpaperService.resetGlobal(req.user.userId);
  }

  @Get("chat/:channelId")
  @ApiOperation({ summary: "Get per-chat wallpaper for current user" })
  getChat(
    @Param("channelId") channelId: string,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.wallpaperService.getChat(req.user.userId, channelId);
  }

  @Get("effective/:channelId")
  @ApiOperation({ summary: "Get resolved wallpaper (chat > global > default)" })
  getEffective(
    @Param("channelId") channelId: string,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.wallpaperService.getEffective(req.user.userId, channelId);
  }

  @Patch("chat/:channelId")
  @ApiOperation({
    summary: "Apply wallpaper to private or group chat (sends system message)",
  })
  applyChat(
    @Param("channelId") channelId: string,
    @Body() dto: ApplyWallpaperDto,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.wallpaperService.applyChat(req.user.userId, channelId, dto);
  }

  @Delete("chat/:channelId")
  @ApiOperation({ summary: "Reset per-chat wallpaper" })
  resetChat(
    @Param("channelId") channelId: string,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.wallpaperService.resetChat(req.user.userId, channelId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get wallpaper by id" })
  getById(
    @Param("id") id: string,
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.wallpaperService.getById(id, req.user.userId);
  }

  @Post(":id/accept")
  @ApiOperation({ summary: "Accept shared wallpaper in a chat" })
  accept(
    @Param("id") id: string,
    @Body() body: AcceptWallpaperDto & { channelId: string },
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.wallpaperService.acceptShared(
      req.user.userId,
      id,
      body.channelId,
      body,
    );
  }

  @Patch(":id/settings")
  @ApiOperation({ summary: "Update wallpaper visual settings" })
  updateSettings(
    @Param("id") id: string,
    @Body()
    dto: UpdateWallpaperSettingsDto & {
      scope?: "global" | "chat";
      channelId?: string;
    },
    @Req() req: Request & { user: { userId: string } },
  ) {
    return this.wallpaperService.updateSettings(
      req.user.userId,
      id,
      dto,
      dto.scope ?? "global",
      dto.channelId,
    );
  }
}
