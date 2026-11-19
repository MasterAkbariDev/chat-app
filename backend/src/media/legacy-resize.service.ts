import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { promises as fs } from "fs";
import { join, resolve, sep, dirname } from "path";
import { randomUUID } from "crypto";
import type { Sharp, SharpOptions } from "sharp";

// sharp's CJS export is the callable itself (see the note in media.service.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require("sharp") as (
  input?: string | Buffer,
  options?: SharpOptions,
) => Sharp;

/** Widths a client may ask for — a small fixed set, so the on-disk cache stays bounded
 *  (at most 3 small WebP files per legacy image) and nobody can make the server encode
 *  an arbitrary number of sizes. */
export const LEGACY_RESIZE_WIDTHS = [320, 640, 1280] as const;

/** Raster formats worth re-encoding. GIF (animation) and SVG (vector, scriptable) are
 *  served as-is through the plain static route instead. */
const RESIZABLE = /\.(jpe?g|png|webp)$/i;
/** One path segment of an old upload: content-hash names, plus the odd timestamped one. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** Refuse to decode anything bigger than ~60 MP (a 25 MB phone panorama is ~50 MP). */
export const LEGACY_RESIZE_MAX_PIXELS = 60_000_000;
/** Encodes allowed at once — the production box is small; the rest wait their turn. */
const MAX_CONCURRENT = 2;

export type LegacyResizeResult =
  | { kind: "file"; path: string }
  | { kind: "not-found" }
  | { kind: "unprocessable" };

export const LEGACY_RESIZE_OPTIONS = Symbol("LEGACY_RESIZE_OPTIONS");

export interface LegacyResizeOptions {
  /** Folders to look for the original in, in order. */
  roots: string[];
  /** Where generated variants are written (`<cacheDir>/<width>/<path>.webp`). */
  cacheDir: string;
}

/** Validates the client-supplied relative path. Returns its segments, or null if it isn't a
 *  plain, traversal-free path to a resizable image. */
export function parseLegacyPath(raw: string): string[] | null {
  if (!raw || raw.length > 400 || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  const segments = raw.split("/");
  if (segments.length > 3) return null;
  if (!segments.every(s => SEGMENT.test(s) && s !== "." && s !== "..")) {
    return null;
  }
  // Never resize our own generated output or MediaService's store.
  if (segments[0] === "_resized" || segments[0] === "media") return null;
  if (!RESIZABLE.test(segments[segments.length - 1])) return null;
  return segments;
}

/** Joins `segments` under `root`, refusing anything that would land outside it. */
function inside(root: string, segments: string[]): string | null {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  return target.startsWith(base + sep) ? target : null;
}

/**
 * Small WebP variants of the old app's full-size `/uploads/<hash>.<ext>` photos, made the
 * first time each one is asked for and kept on disk. A legacy photo in a chat used to cost
 * the full original (median 80 KB, some 25 MB); its 640px variant is a few tens of KB.
 */
@Injectable()
export class LegacyResizeService {
  private readonly logger = new Logger(LegacyResizeService.name);
  private readonly inFlight = new Map<string, Promise<LegacyResizeResult>>();
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly options: LegacyResizeOptions;

  constructor(
    @Optional()
    @Inject(LEGACY_RESIZE_OPTIONS)
    options?: LegacyResizeOptions,
  ) {
    const ownUploads = join(process.cwd(), "uploads");
    this.options = options ?? {
      roots: [ownUploads, process.env.LEGACY_UPLOADS_DIR].filter(
        (r): r is string => !!r,
      ),
      cacheDir: join(ownUploads, "_resized"),
    };
  }

  isAllowedWidth(width: number): boolean {
    return (LEGACY_RESIZE_WIDTHS as readonly number[]).includes(width);
  }

  async variant(width: number, rawPath: string): Promise<LegacyResizeResult> {
    const segments = parseLegacyPath(rawPath);
    if (!segments || !this.isAllowedWidth(width)) return { kind: "not-found" };

    const cached = inside(join(this.options.cacheDir, String(width)), [
      ...segments.slice(0, -1),
      `${segments[segments.length - 1]}.webp`,
    ]);
    if (!cached) return { kind: "not-found" };
    if (await exists(cached)) return { kind: "file", path: cached };

    // Two viewers opening the same chat at once must not both encode the same file.
    const key = cached;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const job = this.generate(width, segments, cached).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, job);
    return job;
  }

  private async generate(
    width: number,
    segments: string[],
    cached: string,
  ): Promise<LegacyResizeResult> {
    let source: string | null = null;
    for (const root of this.options.roots) {
      const candidate = inside(root, segments);
      if (candidate && (await exists(candidate))) {
        source = candidate;
        break;
      }
    }
    if (!source) return { kind: "not-found" };

    await this.acquire();
    try {
      const output = await sharp(source, {
        limitInputPixels: LEGACY_RESIZE_MAX_PIXELS,
        failOn: "none",
        sequentialRead: true,
      })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 78, effort: 3 })
        .toBuffer();
      await fs.mkdir(dirname(cached), { recursive: true });
      // Write-then-rename, so a reader never sees a half-written file.
      const tmp = `${cached}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, output);
      await fs.rename(tmp, cached);
      return { kind: "file", path: cached };
    } catch (err) {
      this.logger.warn(
        `Couldn't resize ${segments.join("/")} to ${width}px: ${(err as Error).message}`,
      );
      return { kind: "unprocessable" };
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise(resolveSlot =>
      this.queue.push(() => {
        this.active++;
        resolveSlot();
      }),
    );
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}
