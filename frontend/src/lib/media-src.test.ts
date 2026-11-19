import { describe, expect, it } from "vitest";
import { API_BASE_URL } from "@/lib/api/base";
import { bubbleImageSources, displayAspect, legacyResizedUrl, mediaFileName, resolveAttachmentUrl, thumbImageSources, viewerImageSources } from "./media-src";

const HASH = "ab".repeat(32);

describe("media-src", () => {
  it("gives grid cells only the small variant, larger ones as fallbacks", () => {
    const m = thumbImageSources(`${API_BASE_URL}/uploads/media/${HASH}/original.jpg`);
    expect(m).toEqual({ src: `${API_BASE_URL}/uploads/media/${HASH}/thumb.jpg`, fallback: `${API_BASE_URL}/uploads/media/${HASH}/web.jpg` });
    const legacy = thumbImageSources(`/uploads/${HASH}.jpg`);
    expect(legacy.src).toBe(legacyResizedUrl(`/uploads/${HASH}.jpg`, 320));
    expect(thumbImageSources("https://cdn.example/x.gif")).toEqual({ src: "https://cdn.example/x.gif" });
  });

  it("resolves relative /uploads links against the API, leaves absolute ones alone", () => {
    expect(resolveAttachmentUrl(`/uploads/${HASH}.jpg`)).toBe(`${API_BASE_URL}/uploads/${HASH}.jpg`);
    expect(resolveAttachmentUrl("https://cdn.example/x.jpg")).toBe("https://cdn.example/x.jpg");
  });

  it("uses the resized route for old photos, relative or absolute", () => {
    expect(legacyResizedUrl(`/uploads/${HASH}.jpg`, 640)).toBe(`${API_BASE_URL}/uploads/_w/640/${HASH}.jpg`);
    expect(legacyResizedUrl(`${API_BASE_URL}/uploads/${HASH}.png`, 320)).toBe(`${API_BASE_URL}/uploads/_w/320/${HASH}.png`);
    const s = bubbleImageSources(`/uploads/${HASH}.webp`);
    expect(s.src).toBe(`${API_BASE_URL}/uploads/_w/640/${HASH}.webp`);
    expect(s.srcSet).toContain("_w/320/");
    expect(s.fallback).toBe(`${API_BASE_URL}/uploads/${HASH}.webp`);
    expect(viewerImageSources(`/uploads/${HASH}.jpg`).src).toBe(`${API_BASE_URL}/uploads/_w/1280/${HASH}.jpg`);
  });

  it("never resizes GIFs, MediaService files or other hosts through the legacy route", () => {
    expect(legacyResizedUrl(`/uploads/${HASH}.gif`, 640)).toBeNull();
    expect(legacyResizedUrl(`/uploads/media/${HASH}/original.jpg`, 640)).toBeNull();
    expect(legacyResizedUrl(`https://elsewhere.example/uploads/${HASH}.jpg`, 640)).toBeNull();
    expect(legacyResizedUrl(`/uploads/../secret.jpg`, 640)).toBeNull();
  });

  it("picks MediaService's small variants for bubbles", () => {
    const s = bubbleImageSources(`${API_BASE_URL}/uploads/media/${HASH}/original.png`);
    expect(s.src).toBe(`${API_BASE_URL}/uploads/media/${HASH}/web.jpg`);
    expect(s.srcSet).toContain(`${HASH}/thumb.jpg 320w`);
    expect(s.fallback).toBe(`${API_BASE_URL}/uploads/media/${HASH}/original.png`);
  });

  it("clamps aspect ratios and falls back when unknown", () => {
    expect(displayAspect(4000, 1000)).toBe(1.9);
    expect(displayAspect(1000, 4000)).toBe(0.6);
    expect(displayAspect(null, null)).toBeCloseTo(4 / 3);
    expect(displayAspect(1200, 1000)).toBe(1.2);
  });

  it("names downloads sensibly", () => {
    expect(mediaFileName(`/uploads/${HASH}.jpg`)).toBe(`${HASH}.jpg`);
    expect(mediaFileName(`${API_BASE_URL}/uploads/media/${HASH}/original.png`)).toBe(`${HASH.slice(0, 12)}-original.png`);
  });
});
