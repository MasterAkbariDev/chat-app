import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class CreateTicketDto {
  @ApiProperty({ example: "I can't sign in", maxLength: 120 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  subject: string;

  @ApiProperty({ maxLength: 4000 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(4000)
  body: string;
}

export class TicketReplyDto {
  @ApiProperty({ maxLength: 4000 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(4000)
  body: string;
}
