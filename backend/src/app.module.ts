import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import {
  ServeStaticModule,
  ServeStaticModuleOptions,
} from "@nestjs/serve-static";
import { ThrottlerModule } from "@nestjs/throttler";
import { ResilientThrottlerGuard } from "./common/guards/resilient-throttler.guard";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import { createRedisClient } from "./common/redis-client";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ScheduleModule } from "@nestjs/schedule";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "crypto";
import { join } from "path";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/auth.guard";
import { ChatModule } from "./chat/chat.module";
import { UserModule } from "./user/user.module";
import { MessageModule } from "./message/message.module";
import { GatewayModule } from "./gateway/gateway.module";
import { GifModule } from "./gif/gif.module";
import { ClipsModule } from "./clips/clips.module";
import { StickerModule } from "./sticker/sticker.module";
import { PacksModule } from "./packs/packs.module";
import { BotsModule } from "./bots/bots.module";
import { UploadModule } from "./upload/upload.module";
// TODO(config-bot): the old `POST /config-logs` + auto-created config-bot user/channel were
// removed in B0 (unauthenticated write route, weak default password). The replacement — a
// curated in-app Config section fed by a foreign crawler over a DNS-VPN — is a separate,
// optional, last initiative (see docs/plans/CONFIG_BOT_PLAN.md), not built until B0-B12 ship.
import { WallpaperModule } from "./wallpaper/wallpaper.module";
import { ChannelsModule } from "./channels/channels.module";
import { ContactsModule } from "./contacts/contacts.module";
import { FoldersModule } from "./folders/folders.module";
import { SearchModule } from "./search/search.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { CallsModule } from "./calls/calls.module";
import { AdminModule } from "./admin/admin.module";
import { AccountModule } from "./account/account.module";
import { ModerationModule } from "./moderation/moderation.module";
import { SupportModule } from "./support/support.module";
import { Response } from "express";
import { parseCorsAllowlist, isOriginAllowed } from "./common/cors-allowlist";
import { isUniqueUploadName } from "./media/upload-cache.util";
import { setUploadSafetyHeaders } from "./media/upload-safety-headers";

/** Static options for one folder served at /uploads (see the module list below). */
function uploadsStatic(rootPath: string): ServeStaticModuleOptions {
  return {
    rootPath,
    serveRoot: "/uploads",
    // No index.html fallback: a missing file falls through to the next folder (or a plain 404).
    renderPath: "/__no-index-fallback__",
    // Everything MediaService ever wrote lives under /uploads/media — served by
    // MediaServeController instead (B11), which reads through the MediaStorage interface so
    // it still works once that's S3/MinIO instead of local disk. Static serving remains for
    // the rest of /uploads (the generic, non-media upload endpoint).
    // /uploads/_w/<width>/<file> — resized WebP variants of old photos, made on demand by
    // LegacyResizeController (src/media/legacy-resize.*). /uploads/_poster/<file>.mp4 — JPEG
    // first frames of old videos, from LegacyPosterController (src/media/legacy-poster.*).
    exclude: [
      "/uploads/media/*path",
      "/uploads/_w/*path",
      "/uploads/_poster/*path",
    ],
    serveStaticOptions: {
      setHeaders: (res, filePath) => {
        // Allow <video crossOrigin> + canvas thumbnails from the web app on another
        // origin — but only an origin on the same allowlist as the rest of the API,
        // never a bare wildcard.
        const allowlist = parseCorsAllowlist(process.env.CORS_ORIGIN);
        const expressRes = res as unknown as Response;
        setUploadSafetyHeaders(expressRes, filePath);
        const requestOrigin = expressRes.req?.headers?.origin;
        if (isOriginAllowed(requestOrigin, allowlist)) {
          expressRes.setHeader("Access-Control-Allow-Origin", requestOrigin!);
          expressRes.setHeader("Vary", "Origin");
        }
        expressRes.setHeader(
          "Access-Control-Allow-Methods",
          "GET, HEAD, OPTIONS",
        );
        // Uploads are named by content hash (or a timestamp), so a name never points at
        // different bytes later — let browsers keep them for a year. Anything else gets a
        // day, revalidated by ETag after that.
        expressRes.setHeader(
          "Cache-Control",
          isUniqueUploadName(filePath)
            ? "public, max-age=31536000, immutable"
            : "public, max-age=86400",
        );
        if (/\.(mp4|webm|ogg|mov|m4v)$/i.test(filePath)) {
          expressRes.setHeader("Accept-Ranges", "bytes");
        }
      },
    },
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    // Structured logging (B11, docs/plans/BACKEND_PLAN.md) — every HTTP request/response is
    // logged as JSON with a correlation id (`x-request-id`, generated if the client didn't send
    // one) attached to every log line for that request, including ones written deep inside a
    // service via the injected `Logger`/`PinoLogger`. `redact` keeps the Authorization header
    // and password fields out of logs even though pino-http would otherwise log request headers.
    LoggerModule.forRoot({
      pinoHttp: {
        genReqId: (req: { headers: Record<string, unknown> }) =>
          (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
        redact: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.password",
          "req.body.currentPassword",
          "req.body.newPassword",
        ],
        transport:
          process.env.NODE_ENV !== "production"
            ? { target: "pino-pretty", options: { singleLine: true } }
            : undefined,
      },
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri:
          config.get<string>("DATABASE_URL") ??
          "mongodb://127.0.0.1:27017/chat",
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ limit: 100, ttl: 60_000 }],
        storage: new ThrottlerStorageRedisService(
          // Fails fast while Redis is unreachable — ResilientThrottlerGuard turns that error
          // into "allow the request through" — and reconnects on its own afterwards.
          createRedisClient(
            "rate limiter",
            config.get<string>("REDIS_URL") ?? undefined,
          ),
        ),
      }),
    }),
    ServeStaticModule.forRoot(
      uploadsStatic(join(process.cwd(), "uploads")),
      // Read-only files from a previous deployment (old /uploads links), checked after this
      // app's own folder. Unset → only the app's own folder.
      ...(process.env.LEGACY_UPLOADS_DIR
        ? [uploadsStatic(process.env.LEGACY_UPLOADS_DIR)]
        : []),
    ),
    AuthModule,
    UserModule,
    ChatModule,
    MessageModule,
    GatewayModule,
    GifModule,
    ClipsModule,
    StickerModule,
    PacksModule,
    BotsModule,
    UploadModule,
    WallpaperModule,
    ChannelsModule,
    ContactsModule,
    FoldersModule,
    SearchModule,
    NotificationsModule,
    CallsModule,
    AdminModule,
    AccountModule,
    ModerationModule,
    SupportModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ResilientThrottlerGuard },
  ],
})
export class AppModule {}
