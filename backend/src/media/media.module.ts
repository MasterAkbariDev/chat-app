import { Module, Provider } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { MediaAsset, MediaAssetSchema } from "./schema/media-asset.schema";
import { MediaService } from "./media.service";
import { MEDIA_STORAGE } from "./storage/media-storage.interface";
import { DiskMediaStorageService } from "./storage/disk-media-storage.service";
import { S3MediaStorageService } from "./storage/s3-media-storage.service";
import { MediaServeController } from "./media-serve.controller";
import { AdminMediaController } from "./admin-media.controller";
import { MediaMaintenanceService } from "./media-maintenance.service";
import { LegacyResizeController } from "./legacy-resize.controller";
import { LegacyResizeService } from "./legacy-resize.service";
import { LegacyPosterController } from "./legacy-poster.controller";
import { LegacyPosterService } from "./legacy-poster.service";

/**
 * MEDIA_STORAGE_DRIVER=s3 switches every MediaService-backed upload (images, videos, clips,
 * stickers, wallpaper) to the self-hosted MinIO container instead of local disk (B11) — no
 * call-site change, since every consumer only ever talks to the MediaStorage interface.
 *
 * Must be a `useFactory`, not a top-level `process.env` read: `main.ts` imports `AppModule`
 * (and everything under it, including this file) before ever calling `NestFactory.create()`,
 * which is what actually runs `ConfigModule.forRoot()`'s dotenv loading — a plain module-level
 * ternary would only ever see whatever was in the shell's own environment before Node started,
 * never a value that lives only in `.env`. `useFactory` defers the read until Nest actually
 * instantiates the provider, well after dotenv has populated `process.env`. Found live: with
 * `MEDIA_STORAGE_DRIVER=s3` only in `.env` (not the shell), uploads kept landing on local disk.
 */
const storageProvider: Provider = {
  provide: MEDIA_STORAGE,
  useFactory: () =>
    process.env.MEDIA_STORAGE_DRIVER === "s3"
      ? new S3MediaStorageService()
      : new DiskMediaStorageService(),
};

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MediaAsset.name, schema: MediaAssetSchema },
    ]),
  ],
  controllers: [
    MediaServeController,
    AdminMediaController,
    LegacyResizeController,
    LegacyPosterController,
  ],
  providers: [
    MediaService,
    storageProvider,
    MediaMaintenanceService,
    LegacyResizeService,
    LegacyPosterService,
  ],
  exports: [MediaService],
})
export class MediaModule {}
