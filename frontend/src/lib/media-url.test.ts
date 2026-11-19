import { describe, expect, it } from "vitest";
import { videoPosterUrl } from "./media-url";

describe("videoPosterUrl", () => {
  it("derives the poster next to a new-style transcoded video", () => {
    expect(videoPosterUrl("https://api.example.com/uploads/media/abc123/original.mp4")).toBe(
      "https://api.example.com/uploads/media/abc123/poster.jpg",
    );
  });

  it("points a migrated legacy clip at the on-demand first-frame route", () => {
    expect(videoPosterUrl("https://api.example.com/uploads/1727712345678.mp4")).toBe(
      "https://api.example.com/uploads/_poster/1727712345678.mp4",
    );
    expect(videoPosterUrl("http://localhost:3097/uploads/clip.MOV")).toBe("http://localhost:3097/uploads/_poster/clip.MOV");
  });

  it("keeps the API's path prefix when a proxy mounts it under one", () => {
    expect(videoPosterUrl("https://example.com/api/chat/uploads/1727712345678.webm")).toBe(
      "https://example.com/api/chat/uploads/_poster/1727712345678.webm",
    );
  });

  it("gives no poster for other media, internal routes or traversal", () => {
    expect(videoPosterUrl("https://api.example.com/uploads/media/abc/web.mp4")).toBeUndefined();
    expect(videoPosterUrl("https://api.example.com/uploads/_poster/x.mp4")).toBeUndefined();
    expect(videoPosterUrl("https://api.example.com/uploads/photo.jpg")).toBeUndefined();
    expect(videoPosterUrl("https://api.example.com/uploads/../x.mp4")).toBeUndefined();
  });
});
