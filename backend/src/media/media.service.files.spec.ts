import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath = require("ffmpeg-static") as string;
import { MediaAsset, MediaAssetSchema } from "./schema/media-asset.schema";
import { MediaService, safeExtension } from "./media.service";
import { DiskMediaStorageService } from "./storage/disk-media-storage.service";
import {
  parseFfmetadata,
  parseStreamInfo,
  probeAudio,
} from "./audio-processing.util";

const execFileAsync = promisify(execFile);

async function ffmpeg(args: string[]) {
  await execFileAsync(
    ffmpegPath,
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { timeout: 60_000 },
  );
}

/** Frame rate + frame count of the first video stream, from ffmpeg's own decode stats. */
async function videoStats(
  path: string,
): Promise<{ fps: number; frames: number; durationSec: number }> {
  const { stderr } = await execFileAsync(
    ffmpegPath,
    ["-hide_banner", "-i", path, "-map", "0:v:0", "-f", "null", "-"],
    { timeout: 60_000 },
  ).catch((e: { stderr: string }) => ({ stderr: e.stderr }));
  const fps = Number(/(\d+(?:\.\d+)?) fps/.exec(stderr)?.[1] ?? 0);
  const frames = Number(
    [...stderr.matchAll(/frame=\s*(\d+)/g)].pop()?.[1] ?? 0,
  );
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const durationSec = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0;
  return { fps, frames, durationSec };
}

describe("audio metadata parsing", () => {
  it("reads global ffmetadata tags (escaped, multi-line) and stops at the first section", () => {
    const tags = parseFfmetadata(
      [
        ";FFMETADATA1",
        "title=A \\= B \\; C",
        "ARTIST=Persian آهنگ",
        "comment=line one\\",
        "line two",
        "[STREAM]",
        "title=Album cover",
      ].join("\n"),
    );
    expect(tags.title).toBe("A = B ; C");
    expect(tags.artist).toBe("Persian آهنگ");
    expect(tags.comment).toBe("line one\nline two");
  });

  it("finds the duration, an audio stream and an attached cover in the -i banner", () => {
    const info = parseStreamInfo(
      [
        "  Duration: 00:03:05.50, start: 0.025056, bitrate: 146 kb/s",
        "  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s",
        "  Stream #0:1: Video: mjpeg (Baseline), yuvj444p, 300x300, 90k tbr (attached pic)",
      ].join("\n"),
    );
    expect(info).toEqual({
      durationSec: 185.5,
      hasAudio: true,
      hasCover: true,
    });
    expect(parseStreamInfo("Stream #0:0: Video: h264, 640x480").hasAudio).toBe(
      false,
    );
  });

  it("keeps only a short safe extension from a client filename", () => {
    expect(safeExtension("Report Final.PDF")).toBe("pdf");
    expect(safeExtension("archive.tar.gz")).toBe("gz");
    expect(safeExtension("noext")).toBe("bin");
    expect(safeExtension("../../evil.<script>")).toBe("bin");
  });
});

describe("MediaService files, music and video notes", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let model: Model<MediaAsset>;
  let service: MediaService;
  let storageRoot: string;
  let srcDir: string;
  let song: Buffer;
  let png: Buffer;
  let webm: Buffer;
  const ownerId = "507f1f77bcf86cd799439011";

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), "media-files-test-"));
    process.env.MEDIA_STORAGE_ROOT = storageRoot;
    srcDir = mkdtempSync(join(tmpdir(), "media-files-src-"));

    // An mp3 with ID3 title/artist and an embedded cover — the fixture is generated here.
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=400x300:rate=1",
      "-frames:v",
      "1",
      join(srcDir, "cover.png"),
    ]);
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-i",
      join(srcDir, "cover.png"),
      "-map",
      "0:a",
      "-map",
      "1:v",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "96k",
      "-c:v",
      "mjpeg",
      "-id3v2_version",
      "3",
      "-metadata",
      "title=غروب (Sunset)",
      "-metadata",
      "artist=The Testers",
      "-metadata:s:v",
      "comment=Cover (front)",
      join(srcDir, "song.mp3"),
    ]);
    song = readFileSync(join(srcDir, "song.mp3"));
    png = readFileSync(join(srcDir, "cover.png"));

    // A variable-frame-rate VP8/Opus WebM like MediaRecorder makes: 12 fps for 3 s.
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=480x480:rate=12:duration=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=600:duration=3",
      "-c:v",
      "libvpx",
      "-b:v",
      "600k",
      "-c:a",
      "libopus",
      join(srcDir, "note.webm"),
    ]);
    webm = readFileSync(join(srcDir, "note.webm"));

    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    model = connection.model(MediaAsset.name, MediaAssetSchema);
    await model.createIndexes();
    service = new MediaService(model, new DiskMediaStorageService());
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
    delete process.env.MEDIA_STORAGE_ROOT;
  });

  it("probes duration, tags and cover from a real mp3", async () => {
    const probe = await probeAudio(join(srcDir, "song.mp3"));
    expect(probe.hasAudio).toBe(true);
    expect(probe.hasCover).toBe(true);
    expect(probe.title).toBe("غروب (Sunset)");
    expect(probe.artist).toBe("The Testers");
    expect(probe.durationSec).toBeGreaterThan(3.8);
    expect(probe.durationSec).toBeLessThan(4.3);
  }, 30_000);

  it("stores music as an audio asset with tags and a cover thumbnail", async () => {
    const asset = await service.ingestFile(song, ownerId, {
      originalName: "song.mp3",
      mimeType: "audio/mpeg",
      preferAudio: true,
    });
    expect(asset.kind).toBe("audio");
    expect(asset.mimeType).toBe("audio/mpeg");
    expect(asset.title).toBe("غروب (Sunset)");
    expect(asset.artist).toBe("The Testers");
    expect(asset.durationSec).toBeGreaterThan(3.8);
    expect(asset.sizeBytes).toBe(song.length);
    expect(asset.variants.original).toMatch(/^audio-[0-9a-f]{64}\/audio\.mp3$/);
    expect(asset.variants.thumb).toMatch(/\/cover\.jpg$/);
    // Cover cropped square, ≤320.
    expect(asset.width).toBe(asset.height);
    expect(asset.width).toBeLessThanOrEqual(320);
    expect(existsSync(join(storageRoot, asset.variants.original))).toBe(true);
    expect(
      readFileSync(join(storageRoot, asset.variants.original)).equals(song),
    ).toBe(true);

    // Same bytes again → the same row, one more reference.
    const again = await service.ingestFile(song, ownerId, {
      originalName: "copy.mp3",
      preferAudio: true,
    });
    expect(String(again._id)).toBe(String(asset._id));
    const row = await model.findById(asset._id).lean();
    expect(row?.refCount).toBe(2);
  }, 60_000);

  it("sends a non-audio file picked as music as a plain file", async () => {
    const bytes = Buffer.from("%PDF-1.4\n% not really a pdf\n");
    const asset = await service.ingestFile(bytes, ownerId, {
      originalName: "Notes.pdf",
      mimeType: "application/pdf",
      preferAudio: true,
    });
    expect(asset.kind).toBe("file");
    expect(asset.mimeType).toBe("application/pdf");
    expect(asset.variants.original).toMatch(/^file-[0-9a-f]{64}\/file\.pdf$/);
    expect(asset.variants.thumb).toBeUndefined();
  }, 30_000);

  it("keeps an image sent as a file byte-for-byte, with a small thumbnail", async () => {
    const asset = await service.ingestFile(png, ownerId, {
      originalName: "screenshot.png",
      mimeType: "image/png",
    });
    expect(asset.kind).toBe("file");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.width).toBe(400);
    expect(asset.height).toBe(300);
    expect(asset.variants.thumb).toMatch(/\/thumb\.jpg$/);
    expect(
      readFileSync(join(storageRoot, asset.variants.original)).equals(png),
    ).toBe(true);
  }, 30_000);

  it("rejects an empty file", async () => {
    await expect(
      service.ingestFile(Buffer.alloc(0), ownerId, { originalName: "x.txt" }),
    ).rejects.toThrow(/empty/);
  });

  it("transcodes a video note to a square 30 fps mp4 without losing length", async () => {
    const asset = await service.ingestVideoNote(webm, ownerId);
    expect(asset.kind).toBe("video");
    expect(asset.width).toBe(480);
    expect(asset.height).toBe(480);
    expect(asset.durationSec).toBeGreaterThan(2.85);
    expect(asset.durationSec).toBeLessThan(3.25);
    const stats = await videoStats(join(storageRoot, asset.variants.original));
    expect(stats.fps).toBe(30);
    // ~90 frames for 3 s at a steady 30 fps (low-fps source frames are repeated, not dropped).
    expect(stats.frames).toBeGreaterThanOrEqual(85);
    expect(stats.frames).toBeLessThanOrEqual(96);
  }, 90_000);
});
