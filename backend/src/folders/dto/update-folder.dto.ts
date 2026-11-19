import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength, IsNumber } from "class-validator";
import { Type } from "class-transformer";
import { ValidateNested } from "class-validator";
import { FolderFiltersDto } from "./folder-filters.dto";

export class UpdateFolderDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  order?: number;

  @ApiProperty({ type: FolderFiltersDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => FolderFiltersDto)
  filters?: FolderFiltersDto;
}
