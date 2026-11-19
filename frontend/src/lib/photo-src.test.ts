import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE_URL } from "@/lib/api/base";
import { photoSources, resolvePhotoSrc } from "./photo-src";

const HASH = "ab".repeat(32);
afterEach(() => vi.unstubAllEnvs());

describe("resolvePhotoSrc", () => {
  it("returns nothing for a missing or blank photo", () => {
    expect(resolvePhotoSrc(undefined)).toBeNull();
    expect(resolvePhotoSrc(null)).toBeNull();
    expect(resolvePhotoSrc("")).toBeNull();
    expect(resolvePhotoSrc("   ")).toBeNull();
    expect(photoSources(undefined)).toBeNull();
  });

  it("sends a relative legacy /uploads photo to the API, resized route first", () => {
    const s = photoSources("/uploads/1772011327559-862008469.webp");
    expect(s).toEqual({
      src: `${API_BASE_URL}/uploads/_w/320/1772011327559-862008469.webp`,
      fallback: `${API_BASE_URL}/uploads/1772011327559-862008469.webp`,
    });
  });

  it("keeps the original of an animated photo a thumbnail was never made for", () => {
    expect(photoSources(`/uploads/media/${HASH}/original.webp`)).toEqual({
      src: `${API_BASE_URL}/uploads/media/${HASH}/thumb.jpg`,
      fallback: `${API_BASE_URL}/uploads/media/${HASH}/original.webp`,
    });
  });

  it("keeps a legacy GIF or SVG on its original file (no resized variant exists)", () => {
    expect(resolvePhotoSrc("/uploads/anim.gif")).toBe(`${API_BASE_URL}/uploads/anim.gif`);
  });

  it("maps every retired host's upload link onto the current API", () => {
    vi.stubEnv("NEXT_PUBLIC_LEGACY_MEDIA_ORIGINS", "https://old.example.com,http://old.example.com:3001");
    const file = `/uploads/${HASH}.webp`;
    for (const host of [
      "https://old.example.com",
      "http://old.example.com:3001",
      "https://old.example.com/api/chat",
    ]) {
      expect(resolvePhotoSrc(`${host}${file}`, { large: true })).toBe(`${API_BASE_URL}/uploads/_w/1280/${HASH}.webp`);
    }
  });

  it("maps a MediaService link on a retired host to the small variant on the API", () => {
    vi.stubEnv("NEXT_PUBLIC_LEGACY_MEDIA_ORIGINS", "https://old.example.com");
    expect(resolvePhotoSrc(`https://old.example.com/uploads/media/${HASH}/web.jpg`)).toBe(
      `${API_BASE_URL}/uploads/media/${HASH}/thumb.jpg`,
    );
  });

  it("prefers the small MediaService variant, with the original as fallback", () => {
    expect(photoSources(`${API_BASE_URL}/uploads/media/${HASH}/original.jpg`)).toEqual({
      src: `${API_BASE_URL}/uploads/media/${HASH}/thumb.jpg`,
      fallback: `${API_BASE_URL}/uploads/media/${HASH}/original.jpg`,
    });
  });

  it("uses the large MediaService variant for full-screen views", () => {
    expect(photoSources(`/uploads/media/${HASH}/original.jpg`, { large: true })).toEqual({
      src: `${API_BASE_URL}/uploads/media/${HASH}/web.jpg`,
      fallback: `${API_BASE_URL}/uploads/media/${HASH}/original.jpg`,
    });
  });

  it("resolves a bare media-relative <hash>/<variant> path against the media route", () => {
    expect(resolvePhotoSrc(`${HASH}/original.jpg`)).toBe(`${API_BASE_URL}/uploads/media/${HASH}/thumb.jpg`);
    expect(resolvePhotoSrc(`/${HASH}/original.jpg`)).toBe(`${API_BASE_URL}/uploads/media/${HASH}/thumb.jpg`);
  });

  it("leaves other absolute URLs, blob: and data: alone", () => {
    expect(resolvePhotoSrc("https://cdn.example.com/a/b.png")).toBe("https://cdn.example.com/a/b.png");
    expect(resolvePhotoSrc("blob:http://localhost/abc")).toBe("blob:http://localhost/abc");
    expect(resolvePhotoSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });

  it("is idempotent, so a value already resolved by a caller resolves to itself", () => {
    const once = resolvePhotoSrc("/uploads/1772011327559-862008469.webp");
    expect(resolvePhotoSrc(once)).toBe(once);
  });
});
