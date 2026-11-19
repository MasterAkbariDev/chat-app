import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
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
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { PacksService } from "./packs.service";
import { CreatePackDto } from "./dto/create-pack.dto";
import { UpdatePackDto } from "./dto/update-pack.dto";
import { AddPackItemsDto } from "./dto/add-pack-items.dto";
import { UpdatePackItemDto } from "./dto/update-pack-item.dto";
import { PackType } from "src/enum/base.enum";

const PACK_ITEM_UPLOAD_MAX_BYTES = 8 * 1024 * 1024; // matches MediaService's own GIF cap
const PACK_MAX_FILES_PER_REQUEST = 20;

@ApiTags("Packs (stickers & animated emoji)")
@Controller({ path: "packs", version: "1" })
@UseGuards(JwtAuthGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class PacksController {
  constructor(private readonly packsService: PacksService) {}

  @Post()
  @ApiOperation({
    summary: "Create a sticker or animated-emoji pack",
    description:
      "Creates an empty pack and auto-adds it to your own collection. Add items afterwards via " +
      "POST /:packId/items.",
  })
  @ApiBody({ type: CreatePackDto })
  create(@Body() dto: CreatePackDto, @Req() req: { user: JWTPayload }) {
    return this.packsService.create(dto, req.user.userId);
  }

  @Get("mine")
  @ApiOperation({ summary: "List packs in my own collection (owned + added)" })
  @ApiQuery({ name: "type", required: false, enum: PackType })
  listMine(@Req() req: { user: JWTPayload }, @Query("type") type?: PackType) {
    return this.packsService.listMine(req.user.userId, type);
  }

  @Put("mine/order")
  @ApiOperation({
    summary: "Reorder my packs",
    description:
      "`packIds` is the new order of some of your packs (e.g. one type's list); they take " +
      "over the positions they already had, so other packs keep theirs.",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: { packIds: { type: "array", items: { type: "string" } } },
    },
  })
  reorderMine(
    @Body("packIds") packIds: string[],
    @Req() req: { user: JWTPayload },
  ) {
    return this.packsService.reorderMine(
      req.user.userId,
      Array.isArray(packIds) ? packIds.map(String) : [],
    );
  }

  @Get("search")
  @ApiOperation({
    summary: "Search discoverable (public) packs",
    description:
      "Matches name, description, or tags. Private packs never appear here.",
  })
  @ApiQuery({ name: "q", required: true })
  @ApiQuery({ name: "type", required: false, enum: PackType })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  search(
    @Query("q") q: string,
    @Req() req: { user: JWTPayload },
    @Query("type") type?: PackType,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.packsService.search(
      q,
      type,
      req.user.userId,
      Number(limit) || 20,
      Number(offset) || 0,
    );
  }

  @Get("search-items")
  @ApiOperation({
    summary: "Search my own packs' items by keyword",
    description:
      "The picker's live 'type an emoji or word to find a matching sticker/emoji' query — " +
      "scoped to packs already in my own collection, same as Telegram.",
  })
  @ApiQuery({ name: "q", required: true })
  @ApiQuery({ name: "type", required: false, enum: PackType })
  @ApiQuery({ name: "limit", required: false })
  searchItems(
    @Query("q") q: string,
    @Req() req: { user: JWTPayload },
    @Query("type") type?: PackType,
    @Query("limit") limit?: string,
  ) {
    return this.packsService.searchMyItems(
      req.user.userId,
      q,
      type,
      Number(limit) || 30,
    );
  }

  @Get("by-slug/:slug")
  @ApiOperation({
    summary: "Resolve a pack invite link",
    description:
      "The 'add a pack via link' flow — works for private packs too.",
  })
  @ApiParam({ name: "slug" })
  findBySlug(@Param("slug") slug: string, @Req() req: { user: JWTPayload }) {
    return this.packsService.findBySlug(slug, req.user.userId);
  }

  @Get(":packId")
  @ApiOperation({
    summary: "Get pack details + items",
    description:
      "Powers the tap-a-sticker preview modal/bottom-sheet. No visibility gate beyond the id " +
      "being known — see Pack schema's doc comment.",
  })
  @ApiParam({ name: "packId" })
  @ApiResponse({ status: 404, description: "Pack not found." })
  findOne(@Param("packId") packId: string, @Req() req: { user: JWTPayload }) {
    return this.packsService.findOne(packId, req.user.userId);
  }

  @Patch(":packId")
  @ApiOperation({ summary: "Edit a pack you own" })
  @ApiParam({ name: "packId" })
  @ApiBody({ type: UpdatePackDto })
  update(
    @Param("packId") packId: string,
    @Body() dto: UpdatePackDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.packsService.updatePack(packId, dto, req.user.userId);
  }

  @Delete(":packId")
  @ApiOperation({ summary: "Delete a pack you own" })
  @ApiParam({ name: "packId" })
  remove(@Param("packId") packId: string, @Req() req: { user: JWTPayload }) {
    return this.packsService.deletePack(packId, req.user.userId);
  }

  @Post(":packId/items")
  @ApiOperation({
    summary: "Upload items (stickers/animated emoji) to a pack you own",
  })
  @ApiParam({ name: "packId" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string", format: "binary" } },
        keywords: {
          type: "string",
          description: "JSON array, applied to every file",
        },
      },
    },
  })
  @ApiResponse({ status: 403, description: "Not the pack owner." })
  @UseInterceptors(
    FilesInterceptor("files", PACK_MAX_FILES_PER_REQUEST, {
      storage: memoryStorage(),
      limits: { fileSize: PACK_ITEM_UPLOAD_MAX_BYTES },
    }),
  )
  addItems(
    @Param("packId") packId: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: AddPackItemsDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.packsService.addItems(
      packId,
      files,
      dto.keywords,
      req.user.userId,
    );
  }

  @Patch(":packId/items/:itemId")
  @ApiOperation({ summary: "Edit an item's search keywords (owner only)" })
  @ApiParam({ name: "packId" })
  @ApiParam({ name: "itemId" })
  @ApiBody({ type: UpdatePackItemDto })
  updateItem(
    @Param("packId") packId: string,
    @Param("itemId") itemId: string,
    @Body() dto: UpdatePackItemDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.packsService.updateItem(packId, itemId, dto, req.user.userId);
  }

  @Delete(":packId/items/:itemId")
  @ApiOperation({ summary: "Remove an item from a pack you own" })
  @ApiParam({ name: "packId" })
  @ApiParam({ name: "itemId" })
  removeItem(
    @Param("packId") packId: string,
    @Param("itemId") itemId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.packsService.removeItem(packId, itemId, req.user.userId);
  }

  @Post(":packId/subscribe")
  @ApiOperation({
    summary: "Add this pack to my collection",
    description:
      "The 'Add' button in the tap-preview modal / after opening an invite link.",
  })
  @ApiParam({ name: "packId" })
  subscribe(@Param("packId") packId: string, @Req() req: { user: JWTPayload }) {
    return this.packsService.subscribe(packId, req.user.userId);
  }

  @Delete(":packId/subscribe")
  @ApiOperation({ summary: "Remove this pack from my collection" })
  @ApiParam({ name: "packId" })
  unsubscribe(
    @Param("packId") packId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.packsService.unsubscribe(packId, req.user.userId);
  }

  @Post(":packId/items/:itemId/use")
  @ApiOperation({ summary: "Record sending this sticker/emoji (usage stats)" })
  @ApiParam({ name: "packId" })
  @ApiParam({ name: "itemId" })
  useItem(
    @Param("packId") packId: string,
    @Param("itemId") itemId: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.packsService.useItem(packId, itemId, req.user.userId);
  }
}
