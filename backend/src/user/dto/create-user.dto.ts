import { ApiProperty } from "@nestjs/swagger";
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from "class-validator";

export class CreateUserDto {
  @ApiProperty({ example: "user@example.com", type: String })
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiProperty({ example: "johndoe", type: String })
  @IsNotEmpty()
  @IsString()
  username: string;

  @ApiProperty({ example: "secret123", type: String, minLength: 6 })
  @IsNotEmpty()
  @IsString()
  @MinLength(6, { message: "Password must be at least 6 characters" })
  password: string;

  @ApiProperty({ example: "John", required: false })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiProperty({ example: "Doe", required: false })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiProperty({ example: "+1234567890", required: false })
  @IsOptional()
  @IsString()
  phoneNumber?: string;
}
