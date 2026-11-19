import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { promises as fs } from "fs";
import { join, resolve, sep, dirname } from "path";
import { randomUUID } from "crypto";
import { extractVideoThumbnail } from "./video-processing.util";

/** Video extensions an old `/uploads/<file>` clip can have. */
const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
/** One path segment of an old upload: content-hash names, plus the odd timestamped one. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** One ffmpeg at a time — a poster is a single-frame decode, but the production box is small. */
const MAX_CONCURRENT = 1;

export type LegacyPosterResult =
  | { kind: "file"; path: string }
  | { kind: "not-found" }
  | { kind: "unprocessable" };

export const LEGACY_POSTER_OPTIONS = Symbol("LEGACY_POSTER_OPTIONS");

export interface LegacyPosterOptions {
  /** Folders to look for the original video in, in order. */
  roots: string[];
  /** Where generated posters are written (`<cacheDir>/<path>.jpg`). */
  cacheDir: string;
}

/** Validates a client-supplied relative path to an old video. Returns its segments, or null
 *  if it isn't a plain, traversal-free path to a video file. */
export function parseLegacyVideoPath(raw: string): string[] | null {
  if (!raw || raw.length > 400 || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  const segments = raw.split("/");
  if (segments.length > 2) return null;
  if (!segments.every(s => SEGMENT.test(s) && s !== "." && s !== "..")) {
    return null;
  }
  // Never poster MediaService's store or our own generated output.
  if (
    ["_resized", "_posters", "_w", "_poster", "media"].includes(segments[0])
  ) {
    return null;
  }
  if (!VIDEO.test(segments[segments.length - 1])) return null;
  return segments;
}

/** Joins `segments` under `root`, refusing anything that would land outside it. */
function inside(root: string, segments: string[]): string | null {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  return target.startsWith(base + sep) ? target : null;
}

/**
 * A JPEG first frame of an old `/uploads/<file>.mp4` clip, made on the first request and
 * kept on disk. Migrated videos have no poster of their own, so without this the chat shows
 * a black box until someone presses play.
 */
@Injectable()
export class LegacyPosterService {
  private readonly logger = new Logger(LegacyPosterService.name);
  private readonly inFlight = new Map<string, Promise<LegacyPosterResult>>();
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly options: LegacyPosterOptions;

  constructor(
    @Optional()
    @Inject(LEGACY_POSTER_OPTIONS)
    options?: LegacyPosterOptions,
  ) {
    const ownUploads = join(process.cwd(), "uploads");
    this.options = options ?? {
      roots: [ownUploads, process.env.LEGACY_UPLOADS_DIR].filter(
        (r): r is string => !!r,
      ),
      cacheDir: join(ownUploads, "_posters"),
    };
  }

  async poster(rawPath: string): Promise<LegacyPosterResult> {
    const segments = parseLegacyVideoPath(rawPath);
    if (!segments) return { kind: "not-found" };

    const cached = inside(this.options.cacheDir, [
      ...segments.slice(0, -1),
      `${segments[segments.length - 1]}.jpg`,
    ]);
    if (!cached) return { kind: "not-found" };
    if (await exists(cached)) return { kind: "file", path: cached };

    // Two viewers opening the same chat at once must not both run ffmpeg on the same clip.
    const pending = this.inFlight.get(cached);
    if (pending) return pending;
    const job = this.generate(segments, cached).finally(() =>
      this.inFlight.delete(cached),
    );
    this.inFlight.set(cached, job);
    return job;
  }

  private async generate(
    segments: string[],
    cached: string,
  ): Promise<LegacyPosterResult> {
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
      await fs.mkdir(dirname(cached), { recursive: true });
      // Write-then-rename, so a reader never sees a half-written frame.
      const tmp = `${cached}.${randomUUID()}.tmp.jpg`;
      await extractVideoThumbnail(source, tmp, 0.1);
      const size = (await fs.stat(tmp)).size;
      if (size === 0) {
        await fs.rm(tmp, { force: true });
        return { kind: "unprocessable" };
      }
      await fs.rename(tmp, cached);
      return { kind: "file", path: cached };
    } catch (err) {
      this.logger.warn(
        `Couldn't make a poster for ${segments.join("/")}: ${(err as Error).message}`,
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
