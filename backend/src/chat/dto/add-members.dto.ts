import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsMongoId,
} from "class-validator";

export class AddMembersDto {
  @ApiProperty({
    example: ["507f1f77bcf86cd799439011"],
    type: [String],
    description:
      "User ids to add as members (group/channel only, admin/owner only).",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  userIds: string[];
}
