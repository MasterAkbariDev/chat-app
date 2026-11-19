import { ApiError, parseErrorMessage, refreshSession } from "./client";
import { clearTokens, getAccessToken } from "./token-store";
import { apiUrl } from "./base";

/** Matches the backend's `FILE_MAX_BYTES` (MediaService) — checked before uploading so a too-big
 *  file fails at once instead of after minutes of upload. */
export const FILE_MAX_BYTES = 200 * 1024 * 1024;

/** `POST /upload/file` — see UploadController.uploadDocument. */
export interface UploadedDocument {
  url: string;
  mediaId: string;
  /** `audio` when the server could read it as music (only asked for with `mode: "music"`). */
  kind: "file" | "audio";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  title: string | null;
  artist: string | null;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
}

/** A multipart POST with upload progress (fetch can't report it) and the same auth +
 *  refresh-on-401 handling as the rest of the API client. Rejects with an `ApiError`, or a
 *  `DOMException("AbortError")` when `signal` aborts. */
function postMultipart<T>(
  path: string,
  form: FormData,
  { onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  retried = false,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(path).toString());
    const token = getAccessToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onabort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    xhr.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new ApiError(0, "The upload failed. Check your connection and try again.", null));
    };
    xhr.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = null;
      }
      if (xhr.status === 401 && !retried) {
        refreshSession().then((ok) => {
          if (ok) postMultipart<T>(path, form, { onProgress, signal }, true).then(resolve, reject);
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

/** Uploads a document (`mode: "file"`) or a music track (`mode: "music"`) for a file / audio
 *  message. Kept byte-for-byte server-side; music gets its tags and cover read there. */
export function uploadDocument(
  file: File,
  mode: "file" | "music",
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<UploadedDocument> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("originalFilename", file.name);
  form.append("mode", mode);
  return postMultipart<UploadedDocument>("/upload/file", form, opts);
}

export interface UploadedVideoNote {
  url: string;
  posterUrl: string;
  durationSec: number | null;
  mediaId: string;
}

/** A recorded round video message → `POST /upload/video` with `kind=video_note`: square, steady
 *  30 fps, audio resynced, full length kept (MediaService.ingestVideoNote). */
export function uploadVideoNote(blob: Blob, filename: string, opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}): Promise<UploadedVideoNote> {
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("kind", "video_note");
  return postMultipart<UploadedVideoNote>("/upload/video", form, opts);
}
