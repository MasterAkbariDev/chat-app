import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsObject, IsOptional, IsString } from "class-validator";
import { Transform } from "class-transformer";

/** Same as `InvokeActionDto` but for a multipart request — `params` arrives as a JSON string. */
export class InvokeActionMultipartDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  actionId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  screenId: string;

  @ApiProperty({ required: false, type: String })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null ? parsed : undefined;
    } catch {
      return undefined;
    }
  })
  @IsObject()
  params?: Record<string, unknown>;
}
