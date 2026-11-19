/**
 * Exports the OpenAPI document to `openapi.json` at the repo root without starting the HTTP
 * listener — run in CI so the spec is always in sync with the code (docs/plans/BACKEND_PLAN.md B1).
 * Boots against an in-memory MongoDB so this needs no real database; it still needs a reachable
 * Redis (REDIS_URL, default localhost) since ThrottlerModule connects at app bootstrap.
 */
import "dotenv/config";
import { writeFileSync } from "fs";
import { join } from "path";
import { MongoMemoryServer } from "mongodb-memory-server";

async function main() {
  const mongod = await MongoMemoryServer.create({
    instance: { launchTimeout: 60_000 },
  });
  process.env.DATABASE_URL = mongod.getUri();
  process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  process.env.CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "openapi-export";

  const { NestFactory } = await import("@nestjs/core");
  const { SwaggerModule } = await import("@nestjs/swagger");
  const { AppModule } = await import("../src/app.module");
  const { buildSwaggerConfig } = await import("../src/swagger-config");

  const app = await NestFactory.create(AppModule, { logger: false });
  const document = SwaggerModule.createDocument(app, buildSwaggerConfig());

  const outPath = join(process.cwd(), "openapi.json");
  writeFileSync(outPath, JSON.stringify(document, null, 2));
  console.log(`Wrote ${outPath}`);

  await app.close();
  await mongod.stop();
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
