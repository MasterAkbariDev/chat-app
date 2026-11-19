import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";

@Schema({ collection: "bot_messages", timestamps: true, versionKey: false })
export class BotMessage {
  @Prop({ required: true, index: true }) userId: string;
  @Prop({ required: true, index: true }) botKey: string;
  @Prop({ required: true, maxlength: 2000 }) text: string;
  createdAt?: Date;
}
export const BotMessageSchema = SchemaFactory.createForClass(BotMessage);
BotMessageSchema.index({ userId: 1, botKey: 1, createdAt: -1 });
