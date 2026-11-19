import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import type { Test as TestRequest } from "supertest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync } from "fs";
import { resolveFfmpegPath } from "./ffmpeg-path.util";
import {
  LEGACY_POSTER_OPTIONS,
  LegacyPosterService,
  parseLegacyVideoPath,
} from "./legacy-poster.service";
import { LegacyPosterController } from "./legacy-poster.controller";

/* eslint-disable @typescript-eslint/no-require-imports -- CJS callable, no esModuleInterop */
const supertest = require("supertest") as (app: unknown) => {
  get: (url: string) => TestRequest;
};
/* eslint-enable @typescript-eslint/no-require-imports */
const request = supertest;

process.env.CORS_ORIGIN ??= "http://localhost:8080";

describe("parseLegacyVideoPath", () => {
  it.each([
    ["1727712345678.mp4", ["1727712345678.mp4"]],
    ["legacy/clip.MOV", ["legacy", "clip.MOV"]],
    ["a.webm", ["a.webm"]],
  ])("accepts %s", (input, expected) => {
    expect(parseLegacyVideoPath(input)).toEqual(expected);
  });

  it.each([
    "../secret.mp4",
    "a/../../x.mp4",
    "/etc/x.mp4",
    "a\\b.mp4",
    "x.jpg",
    "x.mp4\0.png",
    "media/abc/original.mp4",
    "_posters/x.mp4",
    "_poster/x.mp4",
    "a/b/c.mp4",
    "",
  ])("rejects %s", input => {
    expect(parseLegacyVideoPath(input)).toBeNull();
  });
});

const ffmpeg = resolveFfmpegPath();
const hasFfmpeg = (() => {
  try {
    execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

(hasFfmpeg ? describe : describe.skip)("LegacyPoster (service + route)", () => {
  let dir: string;
  let own: string;
  let legacy: string;
  let cacheDir: string;
  let app: INestApplication;
  let service: LegacyPosterService;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "legacy-poster-"));
    own = join(dir, "own");
    legacy = join(dir, "legacy");
    cacheDir = join(own, "_posters");
    for (const d of [own, legacy]) mkdirSync(d, { recursive: true });
    // A 1-second red clip, encoded by the same ffmpeg the server uses.
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x240:d=1",
      "-pix_fmt",
      "yuv420p",
      join(legacy, "1700000000000.mp4"),
    ]);
    writeFileSync(join(legacy, "broken.mp4"), Buffer.from("not a video"));

    const moduleRef = await Test.createTestingModule({
      controllers: [LegacyPosterController],
      providers: [
        LegacyPosterService,
        {
          provide: LEGACY_POSTER_OPTIONS,
          useValue: { roots: [own, legacy], cacheDir },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = moduleRef.get(LegacyPosterService);
  });

  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves a JPEG first frame of a legacy video with an immutable cache", async () => {
    const res = await request(app.getHttpServer())
      .get("/uploads/_poster/1700000000000.mp4")
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    const body = res.body as Buffer;
    // JPEG SOI marker.
    expect(body[0]).toBe(0xff);
    expect(body[1]).toBe(0xd8);
  });

  it("caches the poster on disk and reuses it", async () => {
    const cached = join(cacheDir, "1700000000000.mp4.jpg");
    expect(existsSync(cached)).toBe(true);
    const before = statSync(cached).mtimeMs;
    await request(app.getHttpServer())
      .get("/uploads/_poster/1700000000000.mp4")
      .expect(200);
    expect(statSync(cached).mtimeMs).toBe(before);
  });

  it("encodes a clip only once for concurrent requests", async () => {
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:d=1",
      "-pix_fmt",
      "yuv420p",
      join(legacy, "1700000000001.mp4"),
    ]);
    const spy = jest.spyOn(
      service as unknown as { generate: () => Promise<unknown> },
      "generate",
    );
    const results = await Promise.all(
      Array.from({ length: 4 }, () => service.poster("1700000000001.mp4")),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Set(results.map(r => JSON.stringify(r))).size).toBe(1);
    spy.mockRestore();
  });

  it("404s a file that won't decode, with a short cache", async () => {
    const res = await request(app.getHttpServer())
      .get("/uploads/_poster/broken.mp4")
      .expect(404);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(existsSync(join(cacheDir, "broken.mp4.jpg"))).toBe(false);
  });

  it("rejects traversal and non-video names", async () => {
    await request(app.getHttpServer())
      .get("/uploads/_poster/..%2Fsecret.mp4")
      .expect(404);
    await request(app.getHttpServer())
      .get("/uploads/_poster/1700000000000.jpg")
      .expect(404);
    expect(await service.poster("../own/x.mp4")).toEqual({ kind: "not-found" });
  });

  it("404s a missing clip", async () => {
    await request(app.getHttpServer())
      .get("/uploads/_poster/missing.mp4")
      .expect(404);
  });
});
