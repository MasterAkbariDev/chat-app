import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class RefreshDto {
  @ApiProperty({
    description:
      "The refresh_token from login/register/a previous refresh. Omit it when sending " +
      "`X-Auth-Transport: cookie` — the HttpOnly refresh cookie is used instead.",
    required: false,
  })
  @IsOptional()
  @IsString()
  refresh_token?: string;
}
