import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath = require("ffmpeg-static") as string;
import { MediaAsset, MediaAssetSchema } from "./schema/media-asset.schema";
import { MediaService } from "./media.service";
import { DiskMediaStorageService } from "./storage/disk-media-storage.service";

const execFileAsync = promisify(execFile);

describe("MediaService.ingestVideo (B9 follow-up: video compression + limits)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MediaAssetModel: Model<MediaAsset>;
  let service: MediaService;
  let tempRoot: string;
  let sourceDir: string;
  let tinyMp4: Buffer;

  const ownerId = "507f1f77bcf86cd799439011";

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "media-service-video-test-"));
    process.env.MEDIA_STORAGE_ROOT = tempRoot;
    sourceDir = mkdtempSync(join(tmpdir(), "media-service-video-src-"));

    // A synthetic 2-second, 640x480 clip generated entirely by ffmpeg's own test-source filter —
    // no external fixture file needed. Deliberately larger than 1280 is NOT the point here (it's
    // smaller, so compressVideo's "never upscale" behavior is exercised, not its downscale path).
    const srcPath = join(sourceDir, "source.mp4");
    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x480:rate=10:duration=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:duration=2",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-pix_fmt",
        "yuv420p",
        srcPath,
      ],
      { timeout: 30_000 },
    );
    tinyMp4 = readFileSync(srcPath);

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
    rmSync(sourceDir, { recursive: true, force: true });
    delete process.env.MEDIA_STORAGE_ROOT;
  });

  afterEach(async () => {
    await MediaAssetModel.deleteMany({});
  });

  it("rejects a buffer with no recognizable video magic bytes", async () => {
    await expect(
      service.ingestVideo(Buffer.from("not a video"), ownerId),
    ).rejects.toThrow(/unrecognized video format/i);
  });

  it("rejects a video larger than the 200MB cap", async () => {
    // Cheap way to exceed the cap without actually encoding 200MB: patch a real mp4 header
    // onto an oversized buffer so sniffVideoType passes and the size check is what fires.
    const oversized = Buffer.concat([
      tinyMp4.subarray(0, 12),
      Buffer.alloc(201 * 1024 * 1024),
    ]);
    await expect(service.ingestVideo(oversized, ownerId)).rejects.toThrow(
      /200MB or smaller/i,
    );
  });

  it("transcodes to mp4, extracts a poster frame, and reads duration", async () => {
    const asset = await service.ingestVideo(tinyMp4, ownerId);

    expect(asset.kind).toBe("video");
    expect(asset.mimeType).toBe("video/mp4");
    expect(asset.variants.original).toMatch(/original\.mp4$/);
    expect(asset.variants.poster).toMatch(/poster\.jpg$/);
    expect(asset.durationSec).not.toBeNull();
    expect(asset.durationSec).toBeGreaterThan(1);
    expect(asset.durationSec).toBeLessThan(3);

    const storedOriginal = readFileSync(
      join(tempRoot, asset.variants.original),
    );
    expect(storedOriginal.length).toBeGreaterThan(0);
    const storedPoster = readFileSync(join(tempRoot, asset.variants.poster!));
    // JPEG magic bytes.
    expect(storedPoster[0]).toBe(0xff);
    expect(storedPoster[1]).toBe(0xd8);
  }, 60_000);

  it("dedupes a re-uploaded identical source without re-encoding", async () => {
    const first = await service.ingestVideo(tinyMp4, ownerId);
    const second = await service.ingestVideo(tinyMp4, ownerId);

    const idOf = (doc: MediaAsset) => (doc as unknown as { _id: unknown })._id;
    expect(String(idOf(second))).toBe(String(idOf(first)));
    const count = await MediaAssetModel.countDocuments({});
    expect(count).toBe(1);

    const stored = await MediaAssetModel.findOne({ hash: first.hash }).exec();
    expect(stored?.refCount).toBe(2);
  }, 60_000);

  /** ffmpeg -i stderr for a stored file: { width, height, duration, hasAudio }. */
  async function inspect(rel: string) {
    const out = await execFileAsync(ffmpegPath, [
      "-hide_banner",
      "-i",
      join(tempRoot, rel),
    ]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
    const text = String(out.stderr);
    const dims = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text);
    const dur = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
    return {
      width: dims ? Number(dims[1]) : null,
      height: dims ? Number(dims[2]) : null,
      duration: dur
        ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
        : null,
      hasAudio: /Audio:/.test(text),
    };
  }

  it("encodes an odd-sized source (H.264 needs even sides)", async () => {
    const odd = join(sourceDir, "odd.mp4");
    await execFileAsync(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=321x241:rate=10:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv444p",
      odd,
    ]);
    const asset = await service.ingestVideo(readFileSync(odd), ownerId);
    const info = await inspect(asset.variants.original);
    expect(info.width).toBe(320);
    expect(info.height! % 2).toBe(0);
    expect(asset.width).toBe(info.width);
    expect(asset.height).toBe(info.height);
  }, 60_000);

  it("applies sender edits: trim, mute, rotate 90°, crop — and stores them as a separate asset", async () => {
    const plain = await service.ingestVideo(tinyMp4, ownerId);
    const edited = await service.ingestVideo(tinyMp4, ownerId, undefined, {
      trimStartSec: 0.5,
      trimEndSec: 1.5,
      muted: true,
      rotate: 90,
      crop: { x: 0, y: 0.25, w: 1, h: 0.5 },
      coverSec: 1,
    });
    expect(edited.hash).not.toBe(plain.hash);
    const info = await inspect(edited.variants.original);
    // 640x480 rotated → 480x640, crop half the height → 480x320.
    expect(info.width).toBe(480);
    expect(info.height).toBe(320);
    expect(info.hasAudio).toBe(false);
    expect(info.duration).toBeGreaterThan(0.8);
    expect(info.duration).toBeLessThan(1.25);
    expect(edited.durationSec).toBeLessThan(1.25);
    expect(edited.width).toBe(480);
    expect(edited.height).toBe(320);
    expect(readFileSync(join(tempRoot, edited.variants.poster!))[0]).toBe(0xff);
  }, 60_000);
});
