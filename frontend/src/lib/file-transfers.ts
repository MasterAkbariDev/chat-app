"use client";

import { useSyncExternalStore } from "react";

/** App-wide state of file uploads (keyed by the optimistic message's temp id) and downloads
 *  (keyed by URL), so a bubble that scrolls away and back — or a chat you leave and reopen —
 *  still shows the right progress ring. */

export interface UploadEntry {
  file: File;
  mode: "file" | "music";
  /** 0–1 */
  progress: number;
  status: "uploading" | "sending" | "failed";
  error?: string;
  cancel: () => void;
  retry: () => void;
}

export interface DownloadEntry {
  /** 0–1, or null while the size is unknown. */
  progress: number | null;
  status: "downloading" | "done" | "failed";
  /** Object URL of the downloaded bytes (status "done"). */
  objectUrl?: string;
  error?: string;
}

const uploads = new Map<string, UploadEntry>();
const downloads = new Map<string, DownloadEntry>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function setUpload(id: string, entry: UploadEntry | null) {
  if (entry) uploads.set(id, entry);
  else uploads.delete(id);
  emit();
}

export function patchUpload(id: string, patch: Partial<UploadEntry>) {
  const prev = uploads.get(id);
  if (!prev) return;
  uploads.set(id, { ...prev, ...patch });
  emit();
}

export function getUpload(id: string): UploadEntry | undefined {
  return uploads.get(id);
}

export function useUpload(id: string | undefined): UploadEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (id ? uploads.get(id) : undefined),
    () => undefined,
  );
}

export function useDownload(url: string | undefined): DownloadEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (url ? downloads.get(url) : undefined),
    () => undefined,
  );
}

/** Larger files aren't kept in memory after saving — tapping again downloads again. */
const KEEP_IN_MEMORY_BYTES = 60 * 1024 * 1024;

/** Downloads `url` with progress, then hands it to the browser as `fileName`. A second call while
 *  it's running cancels it. */
export async function startDownload(url: string, fileName: string): Promise<void> {
  const running = controllers.get(url);
  if (running) {
    running.abort();
    return;
  }
  const ctrl = new AbortController();
  controllers.set(url, ctrl);
  downloads.set(url, { progress: 0, status: "downloading" });
  emit();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(res.status === 404 ? "This file is no longer available." : "The download failed.");
    const total = Number(res.headers.get("Content-Length")) || 0;
    let blob: Blob;
    if (res.body && total > 0) {
      const reader = res.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let received = 0;
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        received += value.length;
        const now = performance.now();
        if (now - lastEmit > 80) {
          lastEmit = now;
          downloads.set(url, { progress: Math.min(1, received / total), status: "downloading" });
          emit();
        }
      }
      blob = new Blob(chunks, { type: res.headers.get("Content-Type") ?? "" });
    } else {
      downloads.set(url, { progress: null, status: "downloading" });
      emit();
      blob = await res.blob();
    }
    // Typed by name so the browser opens a PDF or a picture inline instead of saving it.
    const objectUrl = URL.createObjectURL(new Blob([blob], { type: mimeForName(fileName) || blob.type }));
    if (blob.size > KEEP_IN_MEMORY_BYTES) {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      downloads.set(url, { progress: 1, status: "done" });
    } else {
      downloads.set(url, { progress: 1, status: "done", objectUrl });
    }
  } catch (err) {
    if (ctrl.signal.aborted) downloads.delete(url);
    else downloads.set(url, { progress: null, status: "failed", error: err instanceof Error ? err.message : "The download failed." });
  } finally {
    controllers.delete(url);
    emit();
  }
}

/** Opens an already-downloaded file from memory (no second download): a PDF, picture, audio, video
 *  or text file opens in a new tab; anything else is saved from that same copy. False when the
 *  file isn't in memory (too big to keep, or never downloaded), so the caller downloads it. */
export function openDownloaded(url: string, fileName: string): boolean {
  const entry = downloads.get(url);
  if (entry?.status !== "done" || !entry.objectUrl) return false;
  if (isPreviewable(fileName)) window.open(entry.objectUrl, "_blank", "noopener");
  else saveObjectUrl(entry.objectUrl, fileName);
  return true;
}

const PREVIEW_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
};

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

function mimeForName(fileName: string): string {
  return PREVIEW_TYPES[extensionOf(fileName)] ?? "";
}

function isPreviewable(fileName: string): boolean {
  return extensionOf(fileName) in PREVIEW_TYPES;
}

function saveObjectUrl(objectUrl: string, fileName: string) {
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
