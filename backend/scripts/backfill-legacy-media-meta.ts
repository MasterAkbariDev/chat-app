/**
 * Fills in `attachmentMeta` (width, height, blurhash) for photo messages that point at old
 * `/uploads/<file>` files — the ones moved over from the previous app, which never had any.
 * With it, the web app reserves each photo's real shape and shows a blurred preview while
 * it loads, instead of an empty box that jumps when the photo arrives.
 *
 *   npm run migrate:media-meta -- --dry-run      # report only
 *   npm run migrate:media-meta                   # write
 *   # in the production image:
 *   node dist/scripts/backfill-legacy-media-meta.js [--dry-run] [--limit=N]
 *
 * Env: DATABASE_URL (required); LEGACY_UPLOADS_DIR (the old app's uploads folder, optional);
 * UPLOADS_DIR (this app's own uploads folder, default `<cwd>/uploads`).
 *
 * Safe to re-run: only attachments with no entry yet are read, existing entries are kept,
 * and files that can't be found or decoded are skipped (and counted).
 */
import "dotenv/config";
import { MongoClient, AnyBulkWriteOperation, Document } from "mongodb";
import { promises as fs } from "fs";
import { join, resolve, sep } from "path";
import { encode as encodeBlurhash } from "blurhash";
import type { Sharp, SharpOptions } from "sharp";

// sharp's CJS export is the callable itself (see src/media/media.service.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require("sharp") as (
  input?: string | Buffer,
  options?: SharpOptions,
) => Sharp;

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = Number(
  process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] ?? 0,
);
const BATCH = 200;
const URI = process.env.DATABASE_URL;
if (!URI) throw new Error("DATABASE_URL is not set (the new app's database).");

const ROOTS = [
  process.env.UPLOADS_DIR ?? join(process.cwd(), "uploads"),
  process.env.LEGACY_UPLOADS_DIR,
].filter((r): r is string => !!r);

/** `/uploads/<file>` (not MediaService's `/uploads/media/...`), raster image. */
const LEGACY_IMAGE =
  /^\/uploads\/(?!media\/|_w\/|_resized\/)[A-Za-z0-9._/-]+\.(jpe?g|png|webp|gif)$/i;

type MetaEntry = {
  mediaId: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
};

async function findFile(url: string): Promise<string | null> {
  const rel = url.replace(/^\/uploads\//, "");
  if (rel.split("/").some(s => s === ".." || s === "." || s === "")) {
    return null;
  }
  for (const root of ROOTS) {
    const base = resolve(root);
    const path = resolve(base, rel);
    if (!path.startsWith(base + sep)) continue;
    try {
      if ((await fs.stat(path)).isFile()) return path;
    } catch {
      /* try the next folder */
    }
  }
  return null;
}

/** Same blurhash settings as MediaService.computeBlurhash, so old and new photos look alike. */
export async function describeImage(path: string): Promise<MetaEntry | null> {
  try {
    const meta = await sharp(path, {
      failOn: "none",
      limitInputPixels: 100_000_000,
    }).metadata();
    if (!meta.width || !meta.height) return null;
    // EXIF orientations 5–8 are rotated a quarter turn: the photo displays the other way round.
    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;
    let blurhash: string | null = null;
    try {
      const { data, info } = await sharp(path, {
        failOn: "none",
        limitInputPixels: 100_000_000,
      })
        .rotate()
        .raw()
        .ensureAlpha()
        .resize(32, 32, { fit: "inside" })
        .toBuffer({ resolveWithObject: true });
      blurhash = encodeBlurhash(
        new Uint8ClampedArray(data),
        info.width,
        info.height,
        4,
        4,
      );
    } catch {
      /* dimensions alone still prevent the layout jump */
    }
    return { mediaId: "", width, height, blurhash };
  } catch {
    return null;
  }
}

async function main() {
  const client = new MongoClient(URI!);
  await client.connect();
  const messages = client.db().collection("messages");
  const report: Record<string, number> = {};
  const count = (k: string, n = 1) => (report[k] = (report[k] ?? 0) + n);

  console.log(
    `${DRY_RUN ? "[dry run] " : ""}Looking for files in: ${ROOTS.join(", ")}`,
  );

  const cursor = messages
    .find(
      { attachments: { $elemMatch: { $regex: "^/uploads/(?!media/)" } } },
      { projection: { attachments: 1, attachmentMeta: 1 } },
    )
    .batchSize(BATCH);

  let ops: AnyBulkWriteOperation<Document>[] = [];
  const flush = async () => {
    if (!DRY_RUN && ops.length) {
      await messages.bulkWrite(ops, { ordered: false });
    }
    ops = [];
  };

  let seen = 0;
  for await (const m of cursor) {
    if (LIMIT && seen >= LIMIT) break;
    seen++;
    const attachments: unknown[] = Array.isArray(m.attachments)
      ? (m.attachments as unknown[])
      : [];
    const existing = (m.attachmentMeta ?? {}) as Record<string, MetaEntry>;
    const added: Record<string, MetaEntry> = {};
    for (const url of attachments) {
      if (typeof url !== "string" || !LEGACY_IMAGE.test(url)) continue;
      if (existing[url]) {
        count("attachments already described");
        continue;
      }
      const path = await findFile(url);
      if (!path) {
        count("attachments skipped: file not found");
        continue;
      }
      const entry = await describeImage(path);
      if (!entry) {
        count("attachments skipped: not a readable image");
        continue;
      }
      added[url] = entry;
      count("attachments described");
      if (!entry.blurhash) count("attachments described without blurhash");
    }
    if (Object.keys(added).length === 0) continue;
    count("messages updated");
    // The whole object is set (not `attachmentMeta.<url>`): the keys are URLs, and the
    // dots in them would be read as nested paths.
    ops.push({
      updateOne: {
        filter: { _id: m._id },
        update: { $set: { attachmentMeta: { ...existing, ...added } } },
      },
    });
    if (ops.length >= BATCH) {
      await flush();
      console.log(`  …${seen} messages checked`);
    }
  }
  await flush();
  count("messages checked", seen);

  console.log(DRY_RUN ? "Dry run — nothing was written." : "Done.");
  for (const [k, v] of Object.entries(report).sort()) {
    console.log(`  ${k}: ${v}`);
  }
  await client.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
