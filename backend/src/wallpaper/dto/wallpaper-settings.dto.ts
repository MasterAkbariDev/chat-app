import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { WallpaperFitMode } from "../schema/wallpaper.schema";

export class WallpaperSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  blur?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  dim?: number;

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(150)
  brightness?: number;

  @IsOptional()
  @IsEnum(WallpaperFitMode)
  fitMode?: WallpaperFitMode;

  @IsOptional()
  @IsBoolean()
  parallax?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  duration?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  videoStartSec?: number;
}

export class ApplyWallpaperDto extends WallpaperSettingsDto {
  @IsString()
  mediaUrl: string;

  @IsEnum(["image", "video"] as const)
  type: "image" | "video";

  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @IsOptional()
  @IsString()
  originalFilename?: string;

  @ApiProperty({
    required: false,
    description:
      "MediaAsset id returned by the upload endpoint — lets the nightly GC job release the " +
      "reference when this wallpaper is replaced or its scope reset. Omit for a mediaUrl set " +
      "some other way (e.g. a default/preset wallpaper not backed by an upload).",
  })
  @IsOptional()
  @IsString()
  mediaId?: string;
}

export class AcceptWallpaperDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  blur?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  dim?: number;

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(150)
  brightness?: number;
}

export class UpdateWallpaperSettingsDto extends WallpaperSettingsDto {}
