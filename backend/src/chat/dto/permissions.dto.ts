import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional } from "class-validator";

/** Admin rights to set (missing keys keep their current/default value). See chat/permissions.ts. */
export class AdminRightsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() changeInfo?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() deleteMessages?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() banUsers?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() inviteUsers?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pinMessages?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() addAdmins?: boolean;
  @ApiPropertyOptional({ description: "Channels: post" })
  @IsOptional()
  @IsBoolean()
  postMessages?: boolean;
  @ApiPropertyOptional({ description: "Channels: edit others' posts" })
  @IsOptional()
  @IsBoolean()
  editMessages?: boolean;
}

/** Member permissions (chat defaults, or one member's exceptions). */
export class MemberPermissionsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sendMessages?: boolean;
  @ApiPropertyOptional({ description: "Photos, videos, files" })
  @IsOptional()
  @IsBoolean()
  sendMedia?: boolean;
  @ApiPropertyOptional({ description: "Stickers and GIFs" })
  @IsOptional()
  @IsBoolean()
  sendStickers?: boolean;
  @ApiPropertyOptional({ description: "Voice and round video messages" })
  @IsOptional()
  @IsBoolean()
  sendVoice?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() addMembers?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() pinMessages?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() changeInfo?: boolean;
}
