import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

@Schema({
  collection: "blocks",
  timestamps: true,
})
export class Block {
  @Prop({ required: true, type: Types.ObjectId, ref: "User" })
  blockerId: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: "User" })
  blockedId: Types.ObjectId;
}

export const BlockSchema = SchemaFactory.createForClass(Block);

BlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
BlockSchema.index({ blockedId: 1 });
