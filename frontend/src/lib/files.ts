/** Helpers for file and music messages (FileMessage / MusicMessage). */

export type FileCategory = "pdf" | "doc" | "sheet" | "slides" | "archive" | "apk" | "audio" | "video" | "image" | "code" | "text" | "other";

const EXT_CATEGORY: Record<string, FileCategory> = {
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  odt: "doc",
  rtf: "doc",
  pages: "doc",
  xls: "sheet",
  xlsx: "sheet",
  ods: "sheet",
  csv: "sheet",
  numbers: "sheet",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
  key: "slides",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  apk: "apk",
  aab: "apk",
  xapk: "apk",
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  flac: "audio",
  wav: "audio",
  wma: "audio",
  weba: "audio",
  mp4: "video",
  mov: "video",
  mkv: "video",
  webm: "video",
  avi: "video",
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  svg: "image",
  bmp: "image",
  js: "code",
  ts: "code",
  json: "code",
  html: "code",
  css: "code",
  py: "code",
  java: "code",
  kt: "code",
  c: "code",
  cpp: "code",
  sh: "code",
  xml: "code",
  txt: "text",
  md: "text",
  log: "text",
};

/** Person-palette hue (0 red … 7 pink, see globals.css) per category — Telegram colours its file
 *  icons by type; Hearth's per-person tints are the theme-aware, contrast-checked way to do that. */
const CATEGORY_HUE: Record<FileCategory, number> = {
  pdf: 0,
  doc: 4,
  sheet: 2,
  slides: 1,
  archive: 1,
  apk: 3,
  audio: 6,
  video: 7,
  image: 5,
  code: 5,
  text: 4,
  other: 4,
};

export function fileExtension(name: string | null | undefined): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec((name ?? "").trim());
  return m ? m[1].toLowerCase() : "";
}

export function fileCategory(name: string | null | undefined, mime?: string | null): FileCategory {
  const byExt = EXT_CATEGORY[fileExtension(name)];
  if (byExt) return byExt;
  const m = (mime ?? "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("text/")) return "text";
  if (/zip|compressed|archive/.test(m)) return "archive";
  return "other";
}

export function categoryColors(category: FileCategory): { bg: string; fg: string } {
  const i = CATEGORY_HUE[category];
  return { bg: `var(--person-${i}-bg)`, fg: `var(--person-${i}-fg)` };
}

/** "1.4 MB", "820 KB", "12 B" — Telegram-style, one decimal under 10. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)} ${units[u]}`;
}

/** Splits a name so the end (extension and a few characters before it) can stay visible while
 *  the start is ellipsized — a middle ellipsis in CSS. */
export function splitForMiddleEllipsis(name: string): { head: string; tail: string } {
  const chars = Array.from(name);
  if (chars.length <= 12) return { head: name, tail: "" };
  const ext = fileExtension(name);
  const keep = Math.min(chars.length - 4, Math.max(6, ext.length + 5));
  return { head: chars.slice(0, chars.length - keep).join(""), tail: chars.slice(chars.length - keep).join("") };
}

/** Whether a picked file should go out as music (played in the app) rather than a plain file. */
export function looksLikeAudio(file: Pick<File, "name" | "type">): boolean {
  return file.type.startsWith("audio/") || fileCategory(file.name) === "audio";
}

/** A file name from a message, falling back to the URL's last segment. */
export function fileNameOf(originalFilename: string | null | undefined, url: string | undefined): string {
  if (originalFilename?.trim()) return originalFilename.trim();
  if (!url) return "File";
  try {
    const last = decodeURIComponent(url.split("?")[0].split("/").pop() ?? "");
    return last || "File";
  } catch {
    return "File";
  }
}
