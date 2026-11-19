/**
 * One-off, manually-run background copy of every file under `uploads/media/` (everything
 * `MediaService` has ever ingested — images, videos, clips, stickers, wallpaper) into the
 * S3-compatible bucket configured by S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY
 * (B11, docs/plans/BACKEND_PLAN.md — "migrate existing uploads/ (background copy + URL
 * rewrite)"). No URL rewrite is actually needed: relative paths are identical between the disk
 * and S3 backends (`MediaStorage.put`'s `relativePath` argument is stored verbatim either way),
 * so a `MediaAsset`'s `variants` never change — only `MEDIA_STORAGE_DRIVER` needs to flip from
 * "disk" to "s3" once this has run.
 *
 * Safe to re-run: skips any key that already exists in the bucket (`HeadObject` first) rather
 * than re-uploading every file every time.
 *
 * Usage:
 *   npm run migrate:media-to-s3 -- --dry-run   # report only, no writes
 *   npm run migrate:media-to-s3                # actually copy
 */
import "dotenv/config";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import {
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const DRY_RUN = process.argv.includes("--dry-run");

function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (statSync(root, { throwIfNoEntry: false })) walk(root);
  return out;
}

async function main() {
  const mediaRoot = join(process.cwd(), "uploads", "media");
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY must all be set.",
    );
  }

  const client = new S3Client({
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  const files = collectFiles(mediaRoot);
  let copied = 0;
  let skipped = 0;

  for (const fullPath of files) {
    const relativePath = relative(mediaRoot, fullPath).split(sep).join("/");

    let exists = true;
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: relativePath }));
    } catch (err) {
      if (err instanceof NotFound) exists = false;
      else throw err;
    }

    if (exists) {
      skipped++;
      continue;
    }

    if (!DRY_RUN) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: relativePath,
          Body: readFileSync(fullPath),
        }),
      );
    }
    copied++;
  }

  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}media-to-s3: ${files.length} local files, ` +
      `${copied} ${DRY_RUN ? "would copy" : "copied"}, ${skipped} already present`,
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
