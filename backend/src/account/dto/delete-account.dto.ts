import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class DeleteAccountDto {
  @ApiProperty({
    description: "Current password — re-auth required to delete an account",
  })
  @IsNotEmpty()
  @IsString()
  password: string;
}
