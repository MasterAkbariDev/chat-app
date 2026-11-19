import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Sharp, SharpOptions } from "sharp";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require("sharp") as (
  input?: Buffer | Buffer[] | string | SharpOptions,
  options?: SharpOptions,
) => Sharp;
import { MediaAsset, MediaAssetSchema } from "./schema/media-asset.schema";
import { MediaService } from "./media.service";
import { DiskMediaStorageService } from "./storage/disk-media-storage.service";

describe("MediaService (B2: image ingest)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MediaAssetModel: Model<MediaAsset>;
  let service: MediaService;
  let tempRoot: string;

  const ownerId = "507f1f77bcf86cd799439011";

  async function makePngBuffer(width = 800, height = 600): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 200, g: 50, b: 80 },
      },
    })
      .png()
      .toBuffer();
  }

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "media-service-test-"));
    process.env.MEDIA_STORAGE_ROOT = tempRoot;

    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    MediaAssetModel = connection.model(MediaAsset.name, MediaAssetSchema);
    await MediaAssetModel.createIndexes();

    service = new MediaService(MediaAssetModel, new DiskMediaStorageService());
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.MEDIA_STORAGE_ROOT;
  });

  afterEach(async () => {
    await MediaAssetModel.deleteMany({});
  });

  it("rejects a buffer that isn't a real image, regardless of what it's called", async () => {
    const notAnImage = Buffer.from("this is definitely not image bytes");
    await expect(service.ingestImage(notAnImage, ownerId)).rejects.toThrow(
      /unrecognized image format/i,
    );
  });

  it("ingests a PNG: stores original + web + thumb variants, computes dimensions and a blurhash", async () => {
    const buffer = await makePngBuffer(800, 600);
    const asset = await service.ingestImage(buffer, ownerId);

    expect(asset.kind).toBe("image");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.width).toBe(800);
    expect(asset.height).toBe(600);
    expect(asset.blurhash).toEqual(expect.any(String));
    expect(asset.blurhash!.length).toBeGreaterThan(0);
    expect(asset.refCount).toBe(1);

    for (const variant of ["original", "web", "thumb"] as const) {
      const relPath = service.variantPath(asset, variant);
      const onDisk = join(tempRoot, relPath);
      expect(() => readFileSync(onDisk)).not.toThrow();
    }

    // The "web" variant must actually be resized down, not just a copy of the original.
    const webBytes = readFileSync(
      join(tempRoot, service.variantPath(asset, "web")),
    );
    const webMeta = await sharp(webBytes).metadata();
    expect(webMeta.width).toBeLessThanOrEqual(1600);
    const thumbBytes = readFileSync(
      join(tempRoot, service.variantPath(asset, "thumb")),
    );
    const thumbMeta = await sharp(thumbBytes).metadata();
    expect(thumbMeta.width).toBeLessThanOrEqual(320);
  });

  it("never carries EXIF metadata into the stored variants", async () => {
    const source = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 10, g: 10, b: 10 },
      },
    })
      .withMetadata({ exif: { IFD0: { Copyright: "should not survive" } } })
      .jpeg()
      .toBuffer();

    const asset = await service.ingestImage(source, ownerId);
    const originalBytes = readFileSync(
      join(tempRoot, service.variantPath(asset, "original")),
    );
    const meta = await sharp(originalBytes).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("dedupes identical bytes: same hash, refCount increments, no duplicate MediaAsset row", async () => {
    const buffer = await makePngBuffer(400, 300);
    const first = await service.ingestImage(buffer, ownerId);
    const second = await service.ingestImage(buffer, ownerId);

    expect(second.hash).toBe(first.hash);
    const count = await MediaAssetModel.countDocuments({ hash: first.hash });
    expect(count).toBe(1);
    const stored = await MediaAssetModel.findOne({ hash: first.hash }).lean();
    expect(stored?.refCount).toBe(2);
  });

  it("rejects a plain image (jpg/png/webp) over the 20MB cap", async () => {
    // A real 21MB PNG would take a while to encode; patch the size check's own input length
    // instead by padding raw (uncompressed) pixel data — still a real, sniffable PNG.
    const big = await makePngBuffer(4000, 3000);
    if (big.length <= 20 * 1024 * 1024) {
      // Environment-dependent compressibility guard: if sharp compressed this down under the
      // cap, pad it past the cap with trailing bytes PNG readers ignore after the IEND chunk.
      const pad = Buffer.alloc(20 * 1024 * 1024 - big.length + 1024);
      await expect(
        service.ingestImage(Buffer.concat([big, pad]), ownerId),
      ).rejects.toThrow(/20MB or smaller/i);
    } else {
      await expect(service.ingestImage(big, ownerId)).rejects.toThrow(
        /20MB or smaller/i,
      );
    }
  });

  it("rejects an animated GIF over the 8MB cap", async () => {
    const gifHeader = Buffer.from("GIF89a", "ascii");
    const padding = Buffer.alloc(8 * 1024 * 1024 + 1);
    const oversizedGif = Buffer.concat([gifHeader, padding]);
    await expect(service.ingestImage(oversizedGif, ownerId)).rejects.toThrow(
      /GIF must be 8MB or smaller/i,
    );
  });

  it("keeps every frame of an animated WebP (animated stickers/emoji were being flattened to one frame)", async () => {
    const frame = (r: number, g: number, b: number) =>
      sharp({
        create: {
          width: 64,
          height: 64,
          channels: 4,
          background: { r, g, b, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
    const frames = await Promise.all([frame(255, 0, 0), frame(0, 0, 255)]);
    const animated = await sharp(frames, { join: { animated: true } })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);

    const asset = await service.ingestImage(animated, ownerId);
    expect(asset.mimeType).toBe("image/webp");
    expect(asset.width).toBe(64);
    expect(asset.height).toBe(64);
    const stored = readFileSync(join(tempRoot, asset.variants.original));
    expect((await sharp(stored).metadata()).pages).toBe(2);
  });

  it("strips EXIF from an animated WebP without losing its frames", async () => {
    const frame = (r: number) =>
      sharp({
        create: {
          width: 32,
          height: 32,
          channels: 4,
          background: { r, g: 0, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer();
    const frames = await Promise.all([frame(10), frame(200)]);
    const withExif = await sharp(frames, { join: { animated: true } })
      .withExif({ IFD0: { Copyright: "secret-location" } })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const asset = await service.ingestImage(withExif, ownerId);
    const stored = readFileSync(join(tempRoot, asset.variants.original));
    const meta = await sharp(stored).metadata();
    expect(meta.pages).toBe(2);
    expect(meta.exif).toBeUndefined();
  });

  it("makes small pack variants once: an animated 128px thumb plus a still first frame", async () => {
    const frame = (r: number) =>
      sharp({
        create: {
          width: 512,
          height: 512,
          channels: 4,
          background: { r, g: 10, b: 10, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer();
    const frames = await Promise.all([frame(20), frame(220)]);
    const animated = await sharp(frames, { join: { animated: true } })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    const asset = await service.ingestImage(animated, ownerId);

    const withVariants = await service.ensurePackVariants(asset);
    const thumb = await sharp(
      readFileSync(join(tempRoot, withVariants.variants.packThumb!)),
    ).metadata();
    const still = await sharp(
      readFileSync(join(tempRoot, withVariants.variants.packStill!)),
    ).metadata();
    expect(thumb.pages).toBe(2);
    expect(thumb.width).toBe(128);
    expect(thumb.hasAlpha).toBe(true);
    expect(still.pages ?? 1).toBe(1);
    expect(withVariants.variantSizes?.packThumb).toBeGreaterThan(0);

    // Idempotent: a second call reuses what's there.
    expect(MediaService.hasCurrentPackVariants(withVariants)).toBe(true);
    const again = await service.ensurePackVariants(withVariants);
    expect(again.variants.packThumb).toBe(withVariants.variants.packThumb);
  });

  it("uses one variant for both thumb and still when the item isn't animated", async () => {
    const png = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 0.4 },
      },
    })
      .png()
      .toBuffer();
    const asset = await service.ensurePackVariants(
      await service.ingestImage(png, ownerId),
    );
    expect(asset.variants.packThumb).toBe(asset.variants.packStill);
  });

  it("drops frames from fast animations (keeps playback speed) to shrink the small variant", async () => {
    const frames = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        sharp({
          create: {
            width: 64,
            height: 64,
            channels: 4,
            background: { r: i * 20, g: 0, b: 0, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
      ),
    );
    const fast = await sharp(frames, { join: { animated: true } })
      .webp({ loop: 0, delay: Array(12).fill(30) })
      .toBuffer();
    const asset = await service.ensurePackVariants(
      await service.ingestImage(fast, ownerId),
    );
    const meta = await sharp(
      readFileSync(join(tempRoot, asset.variants.packThumb!)),
    ).metadata();
    expect(meta.pages).toBe(6);
    expect(meta.delay!.reduce((a: number, b: number) => a + b, 0)).toBe(360);
  });
});
