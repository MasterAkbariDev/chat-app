import { describe, expect, it } from "vitest";
import { albumLayout, attachmentIsVideo, rowSizes } from "./album-layout";

describe("album layout", () => {
  it("covers every item exactly once for 2–10 items", () => {
    for (let n = 2; n <= 10; n++) {
      const l = albumLayout(Array.from({ length: n }, (_, i) => (i % 2 ? 0.75 : 1.5)));
      const seen = l.kind === "rows" ? l.rows.flatMap((r) => r.items) : [l.first, ...l.rest];
      expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(l.aspect).toBeGreaterThan(0.5);
    }
  });

  it("uses Telegram-like shapes", () => {
    expect(rowSizes(2, [1.5, 1.5])).toEqual([1, 1]);
    expect(rowSizes(2, [0.75, 1])).toEqual([2]);
    expect(rowSizes(3, [1.5, 1, 1])).toEqual([1, 2]);
    expect(rowSizes(5, [1, 1, 1, 1, 1])).toEqual([2, 3]);
    expect(albumLayout([0.6, 1, 1]).kind).toBe("column");
  });

  it("tells video cells from photos", () => {
    expect(attachmentIsVideo("image", "/uploads/media/x/original.jpg", { kind: "video" })).toBe(true);
    expect(attachmentIsVideo("image", "/uploads/media/x/original.jpg", null)).toBe(false);
    expect(attachmentIsVideo("image", "/uploads/media/x/original.mp4", null)).toBe(true);
    expect(attachmentIsVideo("gif", "/a.mp4", null)).toBe(false);
  });
});
