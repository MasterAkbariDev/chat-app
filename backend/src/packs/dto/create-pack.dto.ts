import { ApiProperty } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { PackType } from "src/enum/base.enum";

export class CreatePackDto {
  @ApiProperty({ enum: PackType })
  @IsEnum(PackType)
  type: PackType;

  @ApiProperty({ example: "Party Cats" })
  @IsString()
  @MaxLength(64)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({
    required: false,
    description:
      "Discoverable via pack search. Always addable by link regardless.",
  })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @ApiProperty({
    required: false,
    description:
      "Custom invite-link slug. Auto-derived from name if omitted; immutable once set.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(48)
  slug?: string;
}
