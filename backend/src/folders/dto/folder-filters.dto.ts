import { ApiProperty } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
} from "class-validator";
import { ChatType } from "src/enum/base.enum";

export class FolderFiltersDto {
  @ApiProperty({ enum: ChatType, isArray: true, required: false })
  @IsOptional()
  @IsArray()
  @IsEnum(ChatType, { each: true })
  includeTypes?: ChatType[];

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  includeTags?: string[];

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  includeChannelIds?: string[];

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludeChannelIds?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  onlyUnread?: boolean;
}
