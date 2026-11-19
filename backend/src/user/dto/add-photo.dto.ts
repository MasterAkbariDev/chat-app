import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export class AddPhotoDto {
  @ApiProperty({
    description: "URL returned by POST /upload/image or /upload/avatar-video",
  })
  @IsString()
  @MaxLength(2048)
  url: string;

  @ApiPropertyOptional({ enum: ["image", "video"], default: "image" })
  @IsOptional()
  @IsIn(["image", "video"])
  kind?: "image" | "video";

  @ApiPropertyOptional({
    description: "Required for a video: its poster (still) URL",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  posterUrl?: string;

  @ApiPropertyOptional({
    default: true,
    description: "Make it the photo everybody sees",
  })
  @IsOptional()
  @IsBoolean()
  makeMain?: boolean;
}
