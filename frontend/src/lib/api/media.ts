import { ApiError, parseErrorMessage, refreshSession } from "./client";
import { clearTokens, getAccessToken } from "./token-store";
import { apiUrl } from "./base";


export interface MediaVariantInfo {
  url: string;
  sizeBytes: number | null;
}

export interface UploadedImage {
  url: string;
  mediaId: string;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  /** Both copies the backend already produces for every image — lets the HD/Compressed
   *  toggle pick which one to actually reference in the message without a second upload. */
  variants: { original: MediaVariantInfo; web: MediaVariantInfo };
}

export interface UploadedVideo {
  url: string;
  posterUrl: string;
  durationSec: number | null;
  mediaId: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
}

/** Multipart upload — apiFetch is JSON-only, so this builds the FormData
 * request directly, replaying the same auth + refresh-on-401 +
 * dual-error-envelope handling apiFetch does (see client.ts and bots.ts's
 * `invokeBotActionUpload`, the existing precedent for this exact pattern),
 * since it can't call through to it. `POST /upload/image` is routed through
 * the backend's `MediaService` — magic-byte sniffed, deduplicated, re-encoded,
 * and (best-effort) blurhashed — never trusts the file's claimed extension. */
export async function uploadImage(file: File, _retried = false): Promise<UploadedImage> {
  const token = getAccessToken();
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(apiUrl("/upload/image"), {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });

  if (res.status === 401 && !_retried) {
    const refreshed = await refreshSession();
    if (refreshed) return uploadImage(file, true);
    clearTokens();
  }

  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // non-JSON error body — leave parsed as null
    }
    throw new ApiError(res.status, parseErrorMessage(parsed, res.statusText), parsed);
  }

  return res.json();
}

/** Same multipart pattern as `uploadImage` — see its own comment. `targetResolution`
 * ("480"/"720"/"1080") picks the long-edge cap the backend's ffmpeg pass compresses to;
 * omitted falls back to the pipeline's own ~720p default. */
export async function uploadVideo(
  file: File,
  targetResolution?: "480" | "720" | "1080",
  _retried = false,
): Promise<UploadedVideo> {
  const token = getAccessToken();
  const form = new FormData();
  form.append("file", file);
  if (targetResolution) form.append("targetResolution", targetResolution);

  const res = await fetch(apiUrl("/upload/video"), {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });

  if (res.status === 401 && !_retried) {
    const refreshed = await refreshSession();
    if (refreshed) return uploadVideo(file, targetResolution, true);
    clearTokens();
  }

  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // non-JSON error body — leave parsed as null
    }
    throw new ApiError(res.status, parseErrorMessage(parsed, res.statusText), parsed);
  }

  return res.json();
}

export interface UploadedFile {
  url: string;
  originalFilename?: string;
}

/** Voice messages go through the generic `POST /upload` (stored as-is,
 * deduplicated by content hash) — the backend has no audio transcode step,
 * so the recorder picks the most widely playable container it can
 * (AAC-in-MP4 where the browser can record it, Opus-in-WebM otherwise). */
export async function uploadVoice(blob: Blob, filename: string, _retried = false): Promise<UploadedFile> {
  const token = getAccessToken();
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("originalFilename", filename);

  const res = await fetch(apiUrl("/upload"), {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });

  if (res.status === 401 && !_retried) {
    const refreshed = await refreshSession();
    if (refreshed) return uploadVoice(blob, filename, true);
    clearTokens();
  }

  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // non-JSON error body — leave parsed as null
    }
    throw new ApiError(res.status, parseErrorMessage(parsed, res.statusText), parsed);
  }

  return res.json();
}

export interface UploadedAvatarVideo {
  url: string;
  posterUrl: string;
  durationSec: number | null;
  mediaId: string;
  sizeBytes: number | null;
}

/** A profile video: the server centre-crops it square (640px), cuts it to 10 s, caps it at
 *  30 fps and drops the sound — typically 50–500 KB. Then `addProfilePhoto({ url, posterUrl,
 *  kind: "video" })`. */
export async function uploadAvatarVideo(file: File, edits?: VideoEditsField | null, _retried = false): Promise<UploadedAvatarVideo> {
  const token = getAccessToken();
  const form = new FormData();
  form.append("file", file);
  if (edits) form.append("edits", JSON.stringify(edits));
  const res = await fetch(apiUrl("/upload/avatar-video"), {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (res.status === 401 && !_retried) {
    const refreshed = await refreshSession();
    if (refreshed) return uploadAvatarVideo(file, edits, true);
    clearTokens();
  }
  if (!res.ok) {
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // non-JSON error body — leave parsed as null
    }
    throw new ApiError(res.status, parseErrorMessage(parsed, res.statusText), parsed);
  }
  return res.json();
}

/** Sender edits applied by the server's ffmpeg pass (`edits` form field of `/upload/video` and
 *  `/upload/avatar-video`; backend `parseVideoEdits`). Crop is 0–1 of the rotated frame. */
export interface VideoEditsField {
  trimStartSec?: number;
  trimEndSec?: number;
  muted?: boolean;
  rotate?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  crop?: { x: number; y: number; w: number; h: number };
  coverSec?: number;
}

export interface UploadProgressOptions {
  /** 0–1 as bytes go out (the server's processing time isn't included). */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Multipart POST over XHR — fetch can't report upload progress. Same auth, refresh-on-401
 *  and error envelope handling as the fetch helpers above. Rejects with `ApiError`, or a
 *  `DOMException("AbortError")` when `signal` aborts. */
function postFormWithProgress<T>(path: string, form: FormData, opts: UploadProgressOptions = {}, retried = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(path).toString());
    const token = getAccessToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    const onAbort = () => xhr.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => opts.signal?.removeEventListener("abort", onAbort);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError(0, "The upload failed. Check your connection and try again.", null));
    };
    xhr.onload = () => {
      done();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = null;
      }
      if (xhr.status === 401 && !retried) {
        refreshSession().then((ok) => {
          if (ok) postFormWithProgress<T>(path, form, opts, true).then(resolve, reject);
          else {
            clearTokens();
            reject(new ApiError(401, parseErrorMessage(parsed, "Your session ended. Sign in again."), parsed));
          }
        }, reject);
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const fallback = xhr.status === 413 ? "That file is too big." : xhr.statusText || "The upload failed.";
        reject(new ApiError(xhr.status, parseErrorMessage(parsed, fallback), parsed));
        return;
      }
      resolve(parsed as T);
    };
    xhr.send(form);
  });
}

/** `uploadImage` with progress / cancel — used by the media editor's send queue. */
export function uploadImageWithProgress(file: File, opts: UploadProgressOptions = {}): Promise<UploadedImage> {
  const form = new FormData();
  form.append("file", file, file.name);
  return postFormWithProgress<UploadedImage>("/upload/image", form, opts);
}

/** `uploadVideo` with the editor's server-side edits (trim, mute, rotate, flip, crop, cover)
 *  plus progress / cancel. */
export function uploadEditedVideo(
  file: File,
  { resolution, edits, ...opts }: UploadProgressOptions & { resolution?: "480" | "720" | "1080"; edits?: VideoEditsField | null },
): Promise<UploadedVideo> {
  const form = new FormData();
  form.append("file", file, file.name);
  if (resolution) form.append("targetResolution", resolution);
  if (edits) form.append("edits", JSON.stringify(edits));
  return postFormWithProgress<UploadedVideo>("/upload/video", form, opts);
}
