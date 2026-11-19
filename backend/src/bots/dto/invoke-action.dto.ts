import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsObject, IsOptional, IsString } from "class-validator";

export class InvokeActionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  actionId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  screenId: string;

  @ApiProperty({
    required: false,
    description:
      "The action's own context params merged with any form values typed.",
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}
