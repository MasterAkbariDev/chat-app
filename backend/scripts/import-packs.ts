/**
 * Creates public sticker/emoji packs from a folder of files, owned by an existing user, through
 * the app's own PacksService (so every item goes through MediaService: sniffed, deduped, thumbed).
 *
 *   node dist/scripts/import-packs.js --manifest=/packs/manifest.json --files=/packs/files --owner=<username>
 *
 * The manifest is `deploy/packs/manifest.json`; files are `<files>/<slug>/<item file>` as written
 * by `deploy/packs/fetch-packs.mjs`. A pack whose slug already exists is skipped, so re-running is
 * safe. Prints each pack's add link path (`/app/addpack/<slug>`).
 */
import { NestFactory } from "@nestjs/core";
import { getModelToken } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { AppModule } from "../src/app.module";
import { PacksService } from "../src/packs/packs.service";
import { PackType } from "../src/enum/base.enum";
import { User } from "../src/user/schema/user.schema";

interface ManifestPack {
  slug: string;
  name: string;
  type: "emoji" | "sticker";
  source: "noto" | "fluent";
  description: string;
  tags: string[];
  items: [string, string][];
}

const arg = (name: string) =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const manifestPath = arg("manifest");
  const filesDir = arg("files");
  const ownerName = arg("owner");
  if (!manifestPath || !filesDir || !ownerName) {
    throw new Error(
      "Usage: --manifest=<manifest.json> --files=<dir> --owner=<username>",
    );
  }
  const { packs } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    packs: ManifestPack[];
  };

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"],
  });
  try {
    const users = app.get<Model<User>>(getModelToken(User.name));
    const owner = await users
      .findOne({ username: ownerName })
      .select("_id")
      .lean();
    if (!owner) throw new Error(`No user @${ownerName}`);
    const ownerId = String(owner._id);
    const packsService = app.get(PacksService);

    for (const p of packs) {
      const existing = await packsService
        .findBySlug(p.slug, ownerId)
        .catch(() => null);
      if (existing) {
        console.log(`skip   ${p.slug} (already exists)`);
        continue;
      }
      const pack = await packsService.create(
        {
          type: p.type === "emoji" ? PackType.EMOJI : PackType.STICKER,
          name: p.name,
          slug: p.slug,
          description: p.description,
          tags: p.tags,
          isPublic: true,
        },
        ownerId,
      );
      let added = 0;
      for (const [key, keywords] of p.items) {
        const file = join(
          filesDir,
          p.slug,
          `${key.toLowerCase().replace(/ /g, "_")}.${p.source === "noto" ? "webp" : "png"}`,
        );
        if (!existsSync(file)) continue;
        const buffer = readFileSync(file);
        await packsService.addItems(
          pack.id,
          [
            {
              buffer,
              size: buffer.length,
              originalname: file,
            } as Express.Multer.File,
          ],
          keywords.split(/\s+/).filter(Boolean),
          ownerId,
        );
        added++;
      }
      console.log(
        `create ${p.slug}: ${added} items  → /app/addpack/${pack.slug}`,
      );
    }
  } finally {
    await app.close();
  }
}

main().then(
  // Background timers (schedulers, Redis clients) can outlive app.close(); the work is done.
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  },
);
