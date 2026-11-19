import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class SoftDeleteUserDto {
  @ApiProperty({
    description: "Why the account is being deleted. Internal only.",
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  reason: string;

  @ApiProperty({ description: "The user's username, typed again to confirm." })
  @IsNotEmpty()
  @IsString()
  confirm: string;
}
