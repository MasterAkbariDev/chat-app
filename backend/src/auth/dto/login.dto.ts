import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MinLength, ValidateIf } from "class-validator";

export class LoginDto {
  @ApiProperty({
    example: "user@example.com",
    type: String,
    description: "Email (provide either email or phoneNumber)",
  })
  @ValidateIf((o: LoginDto) => !o.phoneNumber)
  @IsNotEmpty({ message: "Either email or phoneNumber is required" })
  @IsString()
  email?: string;

  @ApiProperty({ example: "123456", type: String })
  @IsNotEmpty()
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({
    example: "+1234567890",
    type: String,
    description: "Phone number (provide either email or phoneNumber)",
  })
  @ValidateIf((o: LoginDto) => !o.email)
  @IsNotEmpty({ message: "Either email or phoneNumber is required" })
  @IsString()
  phoneNumber?: string;
}
