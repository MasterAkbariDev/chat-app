import { ApiProperty } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export class UpdateUserDto {
  @ApiProperty({
    example: "user@example.com",
    type: String,
    required: false,
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: "MrAkbari", type: String, required: false })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiProperty({ example: "Alex", required: false })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiProperty({ example: "Akbari", required: false })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiProperty({
    example: ["https://example.com/avatar.jpg"],
    type: [String],
    required: false,
    description:
      "Wire name for the internal `image` field — matches what every client actually sends.",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  avatarUrl?: string[];

  @ApiProperty({
    example: "Software developer & coffee lover",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @ApiProperty({
    example: true,
    required: false,
    description: "Show emoji-only messages in large size",
  })
  @IsOptional()
  @IsBoolean()
  bigEmojis?: boolean;
}
