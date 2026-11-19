// Must run before `AppModule` is imported: that import pulls in the whole
// dependency graph synchronously, and several modules (e.g. chat.gateway.ts's
// CORS allowlist parsing) read `process.env` at module-evaluation time, not
// inside a Nest DI factory — so they run before `ConfigModule.forRoot()`
// would otherwise load `.env`. Same bug class already fixed once for the S3
// media driver (see media.module.ts's comment); this one wasn't caught.
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { SwaggerModule } from "@nestjs/swagger";
import {
  ValidationPipe,
  VersioningType,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { parseCorsAllowlist } from "./common/cors-allowlist";
import { buildSwaggerConfig } from "./swagger-config";
import { RedisIoAdapter } from "./gateway/redis-io.adapter";

async function bootstrap() {
  // `bufferLogs` holds any log calls made before `useLogger` below runs (e.g. inside module
  // constructors during bootstrap) instead of dropping them — otherwise anything logged before
  // Nest's own logger is swapped for pino would go to Nest's default logger, not pino's JSON
  // output (B11, docs/plans/BACKEND_PLAN.md "structured logging (pino)").
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.use(helmet());
  // Uploaded media (voice notes, videos, files under /uploads and the
  // /uploads/media proxy) is embedded by the web app from a different
  // origin via <audio>/<video>/<img>. Helmet's default
  // `Cross-Origin-Resource-Policy: same-origin` makes the browser refuse
  // those loads outright ("Can't play this clip"), so relax CORP for media
  // paths only — every other route keeps helmet's strict default.
  app.use(
    "/uploads",
    (
      _req: unknown,
      res: { setHeader: (k: string, v: string) => void },
      next: () => void,
    ) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      next();
    },
  );

  // Cross-node Socket.IO delivery (B3) — without this a room only reaches sockets on the
  // same process, so >1 API node silently drops messages to members connected elsewhere.
  const redisIoAdapter = new RedisIoAdapter(
    app,
    process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  );
  redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // Lets a controller opt into `/v1/...` (e.g. ChannelsController) while every controller that
  // doesn't set a `version` keeps responding at its current, unversioned path — see
  // docs/plans/BACKEND_PLAN.md B1 ("introduce /v1 prefix; keep legacy routes alive in parallel").
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: VERSION_NEUTRAL,
  });

  const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
  SwaggerModule.setup("docs", app, document);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject unrecognized body fields instead of silently stripping them — a client
      // sending a field no DTO declares now gets a clear 400 instead of a no-op write.
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Fails closed: no wildcard fallback. CORS_ORIGIN must be set explicitly, even in dev.
  const corsOrigins = parseCorsAllowlist(process.env.CORS_ORIGIN);

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
