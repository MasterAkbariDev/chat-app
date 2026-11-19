import { describe, expect, it } from "vitest";
import { fileCategory, fileNameOf, formatBytes, looksLikeAudio, splitForMiddleEllipsis } from "./files";
import { stickerBox } from "@/components/media/BubbleMedia";

describe("file helpers", () => {
  it("classifies by extension, then MIME type", () => {
    expect(fileCategory("Report.PDF")).toBe("pdf");
    expect(fileCategory("sheet.xlsx")).toBe("sheet");
    expect(fileCategory("app-release.apk")).toBe("apk");
    expect(fileCategory("backup.7z")).toBe("archive");
    expect(fileCategory("noext", "audio/mpeg")).toBe("audio");
    expect(fileCategory("noext", "application/x-whatever")).toBe("other");
  });

  it("formats sizes like Telegram", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(formatBytes(null)).toBe("");
  });

  it("keeps the extension visible when ellipsizing in the middle", () => {
    const { head, tail } = splitForMiddleEllipsis("Quarterly report – final version 2026.pdf");
    expect(head + tail).toBe("Quarterly report – final version 2026.pdf");
    expect(tail.endsWith(".pdf")).toBe(true);
    expect(splitForMiddleEllipsis("a.pdf")).toEqual({ head: "a.pdf", tail: "" });
  });

  it("detects music and falls back to the URL's name", () => {
    expect(looksLikeAudio({ name: "song.MP3", type: "" })).toBe(true);
    expect(looksLikeAudio({ name: "x.bin", type: "audio/flac" })).toBe(true);
    expect(looksLikeAudio({ name: "doc.pdf", type: "application/pdf" })).toBe(false);
    expect(fileNameOf(null, "/uploads/abc%20d.zip")).toBe("abc d.zip");
    expect(fileNameOf(" name.txt ", "/x")).toBe("name.txt");
  });
});

describe("stickerBox", () => {
  it("keeps the sticker's aspect ratio with the long side in 120–200px", () => {
    expect(stickerBox(512, 512)).toEqual({ width: 200, height: 200 });
    expect(stickerBox(300, 512)).toEqual({ width: 117, height: 200 });
    expect(stickerBox(512, 200)).toEqual({ width: 200, height: 78 });
    expect(stickerBox(100, 50)).toEqual({ width: 120, height: 60 });
    expect(stickerBox(150, 150)).toEqual({ width: 150, height: 150 });
    expect(stickerBox(512, 40)).toEqual({ width: 200, height: 48 });
    expect(stickerBox(null, null)).toEqual({ width: 160, height: 160 });
  });
});
