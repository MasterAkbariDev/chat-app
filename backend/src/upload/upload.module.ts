import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { UploadController } from "./upload.controller";
import {
  UploadRecord,
  UploadRecordSchema,
} from "./schema/upload-record.schema";
import { MediaModule } from "src/media/media.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UploadRecord.name, schema: UploadRecordSchema },
    ]),
    MediaModule,
  ],
  controllers: [UploadController],
})
export class UploadModule {}
