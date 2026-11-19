import { Readable } from "stream";

export const MEDIA_STORAGE = Symbol("MEDIA_STORAGE");

export interface MediaByteRange {
  start: number;
  end: number;
}

export interface MediaStreamResult {
  stream: Readable;
  /** Total object size in bytes — independent of how many bytes `stream` actually yields when
   *  `range` was requested, needed to build a correct `Content-Range`/`Content-Length`. */
  sizeBytes: number;
}

/**
 * Storage backend behind an interface so B11 can switch disk → S3-compatible + CDN with no
 * call-site change (docs/plans/BACKEND_PLAN.md B2). Every path is relative — never a full URL —
 * so the interface has no opinion on how a stored file is eventually served.
 *
 * `getStream` (added in B11) is what actually serves a file back — `MediaServeController` reads
 * through it instead of relying on static file-serving, since Express's static middleware can't
 * reach into an S3 bucket. Byte-range support isn't optional here: without it, video seeking
 * (which worked for free under the old static file server) would regress.
 */
export interface MediaStorage {
  /** Writes `data` at `relativePath` (idempotent — the caller only calls this once per unique hash). */
  put(relativePath: string, data: Buffer): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  /** Rejects if `relativePath` doesn't exist — callers already checked existence via `exists()`
   *  or the caller's own `MediaAsset` lookup, so this is never the first check. */
  getStream(
    relativePath: string,
    range?: MediaByteRange,
  ): Promise<MediaStreamResult>;
  /**
   * Removes every object under `hashPrefix` (a `MediaAsset`'s hash — every variant lives at
   * `<hash>/<variant>`) — used only by the admin hard-delete action on a confirmed-refCount-0
   * asset (B11's orphan sweep explicitly archives, never auto-deletes; a human has to ask for
   * this specifically). Never called by anything else.
   */
  deleteAll(hashPrefix: string): Promise<void>;
}
