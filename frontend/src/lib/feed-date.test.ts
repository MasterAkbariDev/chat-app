import { describe, expect, it } from "vitest";
import { formatDateDivider, topVisibleRowIndex } from "./feed-date";

describe("formatDateDivider", () => {
  const now = new Date(2026, 9, 10, 12, 0, 0); // 10 Oct 2026, local noon

  it("labels the current day Today and the day before Yesterday", () => {
    expect(formatDateDivider(new Date(2026, 9, 10, 8, 30).toISOString(), now)).toBe("Today");
    expect(formatDateDivider(new Date(2026, 9, 9, 23, 0).toISOString(), now)).toBe("Yesterday");
  });

  it("uses a locale date for older days and omits the year in the current year", () => {
    const label = formatDateDivider(new Date(2026, 8, 29, 10, 0).toISOString(), now);
    expect(label).toBe(new Date(2026, 8, 29).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
    expect(label).not.toMatch(/2026/);
  });

  it("includes the year for a day in another year", () => {
    const label = formatDateDivider(new Date(2025, 8, 29, 10, 0).toISOString(), now);
    expect(label).toMatch(/2025/);
  });
});

describe("topVisibleRowIndex", () => {
  it("picks the first row whose bottom is still inside the feed", () => {
    const rows = [
      { index: 4, bottom: 10 }, // scrolled off the top
      { index: 5, bottom: 60 }, // straddles the top edge: this is the message at the top
      { index: 6, bottom: 140 },
    ];
    expect(topVisibleRowIndex(rows, 20)).toBe(5);
  });

  it("ignores the slack band at the very top and handles unordered input", () => {
    const rows = [
      { index: 7, bottom: 300 },
      { index: 3, bottom: 40 },
      { index: 2, bottom: 5 },
    ];
    expect(topVisibleRowIndex(rows, 20)).toBe(3);
  });

  it("returns -1 when nothing is visible", () => {
    expect(topVisibleRowIndex([], 0)).toBe(-1);
    expect(topVisibleRowIndex([{ index: 1, bottom: 2 }], 100)).toBe(-1);
  });
});
