import { Module } from "@nestjs/common";
import { GifController } from "./gif.controller";
import { GiphyModule } from "src/giphy/giphy.module";

/** Giphy global-GIF-tab proxy only — see gif.controller.ts. */
@Module({
  imports: [GiphyModule],
  controllers: [GifController],
})
export class GifModule {}
