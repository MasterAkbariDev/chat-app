import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { FoldersService } from "./folders.service";
import { CreateFolderDto } from "./dto/create-folder.dto";
import { UpdateFolderDto } from "./dto/update-folder.dto";

@ApiTags("Folders (v1)")
@Controller({ path: "folders", version: "1" })
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@UseFilters(AllExceptionsFilter)
export class FoldersController {
  constructor(private readonly foldersService: FoldersService) {}

  @Post()
  @ApiOperation({ summary: "Create a chat folder" })
  @ApiBody({ type: CreateFolderDto })
  create(@Body() dto: CreateFolderDto, @Req() req: { user: JWTPayload }) {
    return this.foldersService.create(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List my folders, in order" })
  list(@Req() req: { user: JWTPayload }) {
    return this.foldersService.list(req.user.userId);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a folder's name, order, or filters" })
  @ApiBody({ type: UpdateFolderDto })
  update(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateFolderDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.foldersService.update(req.user.userId, id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a folder" })
  @ApiResponse({ status: 200, description: "{ success: true }" })
  remove(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.foldersService.remove(req.user.userId, id);
  }
}
