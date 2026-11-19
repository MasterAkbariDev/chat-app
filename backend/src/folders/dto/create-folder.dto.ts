import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { Type } from "class-transformer";
import { ValidateNested } from "class-validator";
import { FolderFiltersDto } from "./folder-filters.dto";

export class CreateFolderDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name: string;

  @ApiProperty({ type: FolderFiltersDto, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => FolderFiltersDto)
  filters?: FolderFiltersDto;
}
