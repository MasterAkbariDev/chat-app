import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Exactly one of userId/username/phone/email must be given — validated in the service, not
 * here, so the error message can name which combination is invalid.
 *
 * `userId` is the "Add contact" button path: the frontend already knows exactly who it's
 * adding (a chat member, someone from a shared group) so it sends their id directly — no
 * exact-match lookup needed. `phone` is the primary discovery path (matching a phone contact,
 * like WhatsApp/Telegram — you can only add someone this way if you already know their number).
 * `username`/`email` remain as exact-match fallbacks; nothing here is fuzzy or searchable.
 */
export class AddContactDto {
  @ApiProperty({
    required: false,
    description: "Add directly by id (button-click flow)",
  })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiProperty({
    required: false,
    description: "Primary path — exact match against phoneNumber",
  })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  customName?: string;
}
