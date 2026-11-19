import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Optional,
  Req,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { BotsRegistry } from "./bots.registry";
import { BotMessagesService } from "./bot-messages.service";
import { BotActionResult } from "./bot.interface";
import { InvokeActionDto } from "./dto/invoke-action.dto";
import { InvokeActionMultipartDto } from "./dto/invoke-action-multipart.dto";

const BOT_ACTION_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const BOT_ACTION_MAX_FILES = 20;

/**
 * The generic bot surface (`GET /v1/bots`, `GET /v1/bots/:key/menu`,
 * `POST /v1/bots/:key/action[/upload]`) — see `bot.interface.ts` for the full menu-tree contract.
 * This controller has zero knowledge of what any individual bot does; it only routes to
 * `BotsRegistry` and returns whatever `BotMenuScreen` the handler produces. A new bot never
 * touches this file.
 */
@ApiTags("Bots")
@Controller({ path: "bots", version: "1" })
@UseGuards(JwtAuthGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class BotsController {
  constructor(
    private readonly registry: BotsRegistry,
    @Optional() private readonly messages?: BotMessagesService,
  ) {}

  @Get(":key/messages")
  async history(@Param("key") key: string, @Req() req: { user: JWTPayload }) {
    this.registry.get(key, req.user.userId);
    return this.messages ? this.messages.recent(req.user.userId, key) : [];
  }

  private async record(
    userId: string,
    key: string,
    promise: Promise<BotActionResult>,
  ): Promise<BotActionResult> {
    const result = await promise;
    // The action already ran: a history write failure must not invite a retry.
    if (result.screen.toast && this.messages)
      await this.messages
        .append(userId, key, result.screen.toast)
        .catch(() => undefined);
    return result;
  }

  @Get()
  @ApiOperation({ summary: "List available bots" })
  list(@Req() req: { user: JWTPayload }) {
    return this.registry.list(req.user.userId);
  }

  @Get(":key/menu")
  @ApiOperation({
    summary: "Get a bot menu screen",
    description:
      "GUI-driven, not text commands — the response is a screen (title/rows/buttons) to " +
      "render generically. Defaults to the bot's home screen if `screen` is omitted.",
  })
  @ApiParam({ name: "key" })
  @ApiQuery({ name: "screen", required: false })
  getMenu(
    @Param("key") key: string,
    @Req() req: { user: JWTPayload },
    @Query("screen") screen?: string,
    @Query() query?: Record<string, string>,
  ) {
    const { screen: _screen, ...params } = query ?? {};
    return this.registry
      .get(key, req.user.userId)
      .getScreen(screen ?? "home", req.user.userId, params);
  }

  @Post(":key/action")
  @ApiOperation({ summary: "Invoke a bot action (no file upload)" })
  @ApiParam({ name: "key" })
  @ApiBody({ type: InvokeActionDto })
  invokeAction(
    @Param("key") key: string,
    @Body() dto: InvokeActionDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.record(
      req.user.userId,
      key,
      this.registry
        .get(key, req.user.userId)
        .invokeAction(
          dto.actionId,
          dto.screenId,
          req.user.userId,
          dto.params ?? {},
          [],
        ),
    );
  }

  @Post(":key/action/upload")
  @ApiOperation({
    summary: "Invoke a bot action that includes file uploads",
    description:
      "Same as POST .../action, but multipart — `params` travels as a JSON string.",
  })
  @ApiParam({ name: "key" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        actionId: { type: "string" },
        screenId: { type: "string" },
        params: { type: "string", description: "JSON object" },
        files: { type: "array", items: { type: "string", format: "binary" } },
      },
    },
  })
  @UseInterceptors(
    FilesInterceptor("files", BOT_ACTION_MAX_FILES, {
      storage: memoryStorage(),
      limits: { fileSize: BOT_ACTION_UPLOAD_MAX_BYTES },
    }),
  )
  invokeActionWithUpload(
    @Param("key") key: string,
    @Body() dto: InvokeActionMultipartDto,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: { user: JWTPayload },
  ) {
    return this.record(
      req.user.userId,
      key,
      this.registry
        .get(key, req.user.userId)
        .invokeAction(
          dto.actionId,
          dto.screenId,
          req.user.userId,
          dto.params ?? {},
          files ?? [],
        ),
    );
  }
}
