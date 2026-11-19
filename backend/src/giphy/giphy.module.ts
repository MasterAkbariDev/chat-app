import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { GiphyMedia, GiphyMediaSchema } from "./schema/giphy-media.schema";
import { GiphyClientService } from "./giphy-client.service";
import { GiphyService } from "./giphy.service";
import { MediaModule } from "src/media/media.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: GiphyMedia.name, schema: GiphyMediaSchema },
    ]),
    MediaModule,
  ],
  providers: [GiphyClientService, GiphyService],
  exports: [GiphyService],
})
export class GiphyModule {}
