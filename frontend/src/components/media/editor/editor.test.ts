import { describe, expect, it } from "vitest";
import { fitAspect, flipRect, resize, rotateRect } from "./CropOverlay";
import { groupParts } from "./use-media-send-queue";
import { outputSize, straightenScale } from "./render";
import { FULL_RECT, NO_VIDEO_EDITS, videoEditsPayload, type PreparedMedia } from "./types";
import { cappedSize } from "@/lib/image-quality";

const img = (n: number): PreparedMedia => ({ kind: "image", file: new File([String(n)], `${n}.jpg`), width: 10, height: 10 });

describe("media editor maths", () => {
  it("fits a square crop into a 3:2 frame, centred", () => {
    const r = fitAspect(1, 3000, 2000, FULL_RECT);
    expect(r.h).toBeCloseTo(1);
    expect(r.w * 3000).toBeCloseTo(2000);
    expect(r.x).toBeCloseTo((1 - r.w) / 2);
  });

  it("keeps a locked aspect while resizing and stays inside the frame", () => {
    const r = resize({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, "se", 0.9, 0.1, 1);
    expect(r.w).toBeCloseTo(r.h);
    expect(r.x + r.w).toBeLessThanOrEqual(1.0001);
    expect(r.y + r.h).toBeLessThanOrEqual(1.0001);
  });

  it("rotates and flips crop rects with the frame", () => {
    expect(rotateRect({ x: 0, y: 0, w: 0.5, h: 0.25 })).toEqual({ x: 0.75, y: 0, w: 0.25, h: 0.5 });
    expect(flipRect({ x: 0.1, y: 0, w: 0.3, h: 1 }).x).toBeCloseTo(0.6);
  });

  it("caps output size without upscaling", () => {
    expect(outputSize(3000, 2000, FULL_RECT, 1280)).toMatchObject({ w: 1280, h: 853 });
    expect(outputSize(800, 600, FULL_RECT, 1280)).toMatchObject({ w: 800, h: 600 });
    expect(cappedSize(900, 600, 2560)).toEqual({ w: 900, h: 600 });
  });

  it("scales a straightened image enough to cover its frame", () => {
    expect(straightenScale(100, 100, 0)).toBe(1);
    expect(straightenScale(100, 100, 45)).toBeCloseTo(Math.SQRT2);
  });

  it("only sends video edits that change something", () => {
    expect(videoEditsPayload(NO_VIDEO_EDITS, 10)).toBeNull();
    expect(videoEditsPayload({ ...NO_VIDEO_EDITS, trimStart: 1, trimEnd: 9.99, muted: true, rotate: 1 }, 10)).toEqual({ trimStartSec: 1, muted: true, rotate: 90 });
  });

  it("groups consecutive photos into albums of at most 10", () => {
    const v: PreparedMedia = { kind: "gif", file: new File(["g"], "g.gif") };
    const parts = groupParts([...Array.from({ length: 12 }, (_, i) => img(i)), v, img(99)]);
    expect(parts.map((p) => (p.kind === "album" ? p.items.length : p.item.kind))).toEqual([10, 2, "gif", 1]);
  });

  it("puts photos and videos picked together into one album", () => {
    const vid: PreparedMedia = { kind: "video", file: new File(["v"], "v.mp4"), edits: null, resolution: "720", durationSec: 3 };
    const parts = groupParts([img(1), vid, img(2)]);
    expect(parts).toHaveLength(1);
    expect(parts[0].kind === "album" && parts[0].items.map((i) => i.kind)).toEqual(["image", "video", "image"]);
  });
});
