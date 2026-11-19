import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";

@Schema({
  collection: "upload_records",
  timestamps: true,
})
export class UploadRecord {
  @Prop({ required: true, unique: true })
  hash: string;

  @Prop({ required: true })
  filename: string;
}

export const UploadRecordSchema = SchemaFactory.createForClass(UploadRecord);
UploadRecordSchema.index({ hash: 1 }, { unique: true });
