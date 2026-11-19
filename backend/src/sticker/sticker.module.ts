import { Module } from "@nestjs/common";
import { StickerController } from "./sticker.controller";
import { GiphyModule } from "src/giphy/giphy.module";

/**
 * Only the Giphy-backed "Global" trending/search tab lives here now — owned sticker packs (and
 * the new animated-emoji packs) moved to `src/packs/` (see its own doc comments) so both share
 * one pack/subscription/keyword-search implementation instead of stickers having a bespoke one.
 */
@Module({
  imports: [GiphyModule],
  controllers: [StickerController],
})
export class StickerModule {}
