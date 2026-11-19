import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import type { Sharp, SharpOptions } from "sharp";
import type { Test as TestRequest } from "supertest";

/* eslint-disable @typescript-eslint/no-require-imports -- CJS callables, no esModuleInterop */
const sharp = require("sharp") as (
  input?: unknown,
  options?: SharpOptions,
) => Sharp;
const supertest = require("supertest") as (app: unknown) => {
  get: (url: string) => TestRequest;
};
/* eslint-enable @typescript-eslint/no-require-imports */
const request = supertest;
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  LEGACY_RESIZE_OPTIONS,
  LegacyResizeService,
  parseLegacyPath,
} from "./legacy-resize.service";
import { LegacyResizeController } from "./legacy-resize.controller";
import { isUniqueUploadName } from "./upload-cache.util";

process.env.CORS_ORIGIN ??= "http://localhost:8080";

const HASH = "a".repeat(64);

describe("parseLegacyPath", () => {
  it.each([
    [`${HASH}.jpg`, [`${HASH}.jpg`]],
    [`${HASH}.JPEG`, [`${HASH}.JPEG`]],
    [`wallpapers/${HASH}.png`, ["wallpapers", `${HASH}.png`]],
  ])("accepts %s", (input, expected) => {
    expect(parseLegacyPath(input)).toEqual(expected);
  });

  it.each([
    "../secret.jpg",
    "a/../../etc/passwd.jpg",
    "..%2fx.jpg",
    "/etc/x.jpg",
    "a\\b.jpg",
    ".hidden.jpg",
    "x.gif",
    "x.svg",
    "x.jpg\0.png",
    "media/abc/web.jpg",
    "_resized/640/x.jpg",
    "",
  ])("rejects %s", input => {
    expect(parseLegacyPath(input)).toBeNull();
  });
});

describe("isUniqueUploadName", () => {
  it("treats content-hash and timestamp names as immutable", () => {
    expect(isUniqueUploadName(`/x/${HASH}.jpg`)).toBe(true);
    expect(isUniqueUploadName("/x/wallpaper-1727712345678.png")).toBe(true);
    expect(isUniqueUploadName("/x/logo.png")).toBe(false);
  });
});

describe("LegacyResize (service + route)", () => {
  let dir: string;
  let own: string;
  let legacy: string;
  let cacheDir: string;
  let app: INestApplication;
  let service: LegacyResizeService;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "legacy-resize-"));
    own = join(dir, "own");
    legacy = join(dir, "legacy");
    cacheDir = join(own, "_resized");
    for (const d of [own, legacy]) mkdirSync(d, { recursive: true });
    const jpeg = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "#c33" },
    })
      .jpeg()
      .toBuffer();
    writeFileSync(join(legacy, `${HASH}.jpg`), jpeg);
    writeFileSync(join(legacy, "broken.jpg"), Buffer.from("not an image"));
    writeFileSync(join(dir, "outside.jpg"), jpeg);

    const moduleRef = await Test.createTestingModule({
      controllers: [LegacyResizeController],
      providers: [
        LegacyResizeService,
        {
          provide: LEGACY_RESIZE_OPTIONS,
          useValue: { roots: [own, legacy], cacheDir },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    service = moduleRef.get(LegacyResizeService);
  });

  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves a resized WebP with a year-long immutable cache and an ETag", async () => {
    const res = await request(app.getHttpServer())
      .get(`/uploads/_w/640/${HASH}.jpg`)
      .expect(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.etag).toBeTruthy();
    const meta = await sharp(res.body as Buffer).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(320);
  });

  it("serves the second hit from the disk cache without re-encoding", async () => {
    const cached = join(cacheDir, "640", `${HASH}.jpg.webp`);
    expect(existsSync(cached)).toBe(true);
    const before = statSync(cached).mtimeMs;
    await request(app.getHttpServer())
      .get(`/uploads/_w/640/${HASH}.jpg`)
      .expect(200);
    expect(statSync(cached).mtimeMs).toBe(before);
  });

  it("encodes a file only once for concurrent requests", async () => {
    const spy = jest.spyOn(
      service as unknown as { generate: () => Promise<unknown> },
      "generate",
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.variant(320, `${HASH}.jpg`)),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Set(results.map(r => JSON.stringify(r))).size).toBe(1);
    spy.mockRestore();
  });

  it("rejects widths outside the allowlist", async () => {
    await request(app.getHttpServer())
      .get(`/uploads/_w/500/${HASH}.jpg`)
      .expect(404);
  });

  it("rejects path traversal", async () => {
    for (const path of [
      "/uploads/_w/640/..%2Foutside.jpg",
      "/uploads/_w/640/%2E%2E/outside.jpg",
      "/uploads/_w/640/x/..%2F..%2Foutside.jpg",
    ]) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).toBe(404);
    }
    expect(await service.variant(640, "../outside.jpg")).toEqual({
      kind: "not-found",
    });
  });

  it("404s a missing file", async () => {
    await request(app.getHttpServer())
      .get(`/uploads/_w/640/${"b".repeat(64)}.jpg`)
      .expect(404);
  });

  it("redirects to the original when the file can't be decoded", async () => {
    const res = await request(app.getHttpServer())
      .get("/uploads/_w/640/broken.jpg")
      .expect(302);
    expect(res.headers.location).toBe("../../broken.jpg");
  });
});
