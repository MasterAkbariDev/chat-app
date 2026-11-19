import { ApiProperty } from "@nestjs/swagger";
import { MeDto } from "./user-view.dto";

/** Returned by login/register/logout-all/change-password. Never add `tokenVersion` here. */
export class SessionDto {
  @ApiProperty({
    description: "Bearer JWT for the Authorization header, ~15min TTL",
  })
  access_token: string;

  @ApiProperty({
    description:
      "Opaque token for POST /auth/refresh — single-use, rotates every call",
  })
  refresh_token: string;

  @ApiProperty({ type: MeDto })
  user: MeDto;
}
