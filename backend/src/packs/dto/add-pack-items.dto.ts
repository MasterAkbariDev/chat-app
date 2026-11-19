import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsOptional, IsString } from "class-validator";
import { Transform } from "class-transformer";

/**
 * Multipart body alongside the uploaded `files[]`. `keywords` applies to every file in this one
 * upload batch (per-item keyword editing afterward is `PATCH /v1/packs/:packId/items/:itemId`) —
 * sent as a JSON array string since multipart fields are all strings.
 */
export class AddPackItemsDto {
  @ApiProperty({
    required: false,
    type: String,
    example: '["😂","😆"]',
    description:
      "JSON array of search keywords applied to every uploaded item.",
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : undefined;
    } catch {
      return undefined;
    }
  })
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];
}
