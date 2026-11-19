import { ApiProperty } from "@nestjs/swagger";
import { PublicUserDto } from "src/common/dto/user-view.dto";

/** One row in `GET /v1/contacts` — everything the address book needs to render per contact. */
export class ContactSummaryDto {
  @ApiProperty({ description: "The contact row's own id (for PATCH/DELETE)" })
  _id: string;

  @ApiProperty({ type: PublicUserDto })
  user: PublicUserDto;

  @ApiProperty({ nullable: true })
  customName: string | null;

  @ApiProperty()
  savedAt: Date;

  @ApiProperty()
  isOnline: boolean;

  @ApiProperty({
    nullable: true,
    description: "Existing 1:1 chat with this contact, if any",
  })
  channelId: string | null;

  @ApiProperty({ nullable: true })
  lastMessageAt: Date | null;

  @ApiProperty({ nullable: true })
  lastMessagePreview: string | null;
}
