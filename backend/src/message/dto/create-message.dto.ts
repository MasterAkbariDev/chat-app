import { ApiProperty } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsEnum,
  IsArray,
  IsNumber,
  MaxLength,
  ValidateIf,
  ValidateNested,
  ArrayMaxSize,
} from "class-validator";
import { Type } from "class-transformer";
import { CustomEmojiEntityDto } from "./custom-emoji.dto";
import { MessageType } from "src/enum/base.enum";

export class CreateMessageDto {
  @ApiProperty({
    example: "507f1f77bcf86cd799439011",
    description: "Chat/channel ID",
  })
  @IsNotEmpty()
  @IsString()
  channelId: string;

  @ApiProperty({
    example: "Hello everyone!",
    description: "Message content (or URL for voice/image)",
  })
  @ValidateIf(
    (obj: { attachments: string[] }) =>
      !obj?.attachments || obj?.attachments?.length === 0,
  )
  @IsString()
  @IsNotEmpty({ message: "Content is required unless you attach a file" })
  @MaxLength(4000)
  content: string;

  @ApiProperty({
    example: MessageType.TEXT,
    enum: MessageType,
    required: false,
  })
  @IsOptional()
  @IsEnum(MessageType)
  type?: MessageType;

  @ApiProperty({ example: [], type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];

  @ApiProperty({
    description:
      "The `mediaId` returned by POST /upload/image or /upload/video for each entry in " +
      "`attachments`, in the same order — lets the server build `attachmentMeta` " +
      "(width/height/blurhash) from the real MediaAsset row instead of trusting client-claimed " +
      "values. Omit an entry (or the whole array) for an attachment with no known MediaAsset " +
      "(e.g. a GIF from the generic /upload path) — it just won't get a blurhash placeholder.",
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentMediaIds?: string[];

  @ApiProperty({ example: "507f1f77bcf86cd799439012", required: false })
  @IsOptional()
  @IsString()
  replyTo?: string;

  @ApiProperty({
    example: 12,
    description: "Voice message duration in seconds",
    required: false,
  })
  @IsOptional()
  @IsNumber()
  durationSec?: number;

  @ApiProperty({
    example: [0.1, 0.4, 0.8, 0.3],
    description: "Voice message waveform samples (0-1 range), for rendering",
    type: [Number],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  waveform?: number[];

  @ApiProperty({
    example: "vacation-photo.jpg",
    description: "Original filename as uploaded by the sender's client",
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalFilename?: string;

  @ApiProperty({
    description:
      "File name of each entry in `attachments`, same order — for a message with several " +
      "files (Telegram-style file group). Stored per attachment in `attachmentMeta[url].fileName`.",
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  attachmentNames?: string[];

  @ApiProperty({
    description: "Client temp id for optimistic UI; echoed in new_message",
    required: false,
  })
  @IsOptional()
  @IsString()
  tempId?: string;

  @ApiProperty({
    description:
      "When present, creates a forwarded message that references the given message id. " +
      "The new message content/type/attachments will be copied from the original.",
    required: false,
    example: "507f1f77bcf86cd799439099",
  })
  @IsOptional()
  @IsString()
  forwardFrom?: string;

  @ApiProperty({
    description:
      "Set when this message is a sticker/animated-emoji sent from a pack item (usually " +
      "type: 'sticker'). The caller must already have the pack (owner or subscriber) — the " +
      "server authorizes it and bumps its usage, same rule as reacting with one. Lets a " +
      "received sticker be traced back to its pack so it can be tapped to open/add it.",
    required: false,
    example: "507f1f77bcf86cd799439013",
  })
  @IsOptional()
  @IsString()
  packItemId?: string;

  @ApiProperty({
    description:
      "Animated emoji placed inline in a text message — each entity marks the unicode " +
      "fallback span in `content` and the pack item to draw there. Items must come from an " +
      "animated-emoji pack the sender owns or has added (same rule as stickers).",
    required: false,
    type: [CustomEmojiEntityDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CustomEmojiEntityDto)
  customEmoji?: CustomEmojiEntityDto[];
}
