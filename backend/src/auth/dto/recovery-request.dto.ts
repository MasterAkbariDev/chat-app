import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class RecoveryRequestDto {
  @ApiProperty({ example: "johndoe", description: "Username or email" })
  @IsNotEmpty()
  @IsString()
  identifier: string;
}

export class RecoveryResetDto {
  @ApiProperty({ example: "a-new-strong-password" })
  @IsNotEmpty()
  @IsString()
  newPassword: string;
}
