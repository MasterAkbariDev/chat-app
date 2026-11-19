import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MinLength } from "class-validator";

export class ChangePasswordDto {
  @ApiProperty({ example: "oldpass123", description: "Current password" })
  @IsNotEmpty()
  @IsString()
  currentPassword: string;

  @ApiProperty({
    example: "newpass456",
    description: "New password (min 6 characters)",
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(6)
  newPassword: string;
}
