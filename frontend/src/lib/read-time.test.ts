import { describe, expect, it } from "vitest";
import { formatReadTime } from "./read-time";

const now = new Date(2026, 9, 6, 15, 30);
const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

describe("formatReadTime", () => {
  it("uses 'today' and 'yesterday' with the local time", () => {
    const today = new Date(2026, 9, 6, 14, 5);
    const yesterday = new Date(2026, 9, 5, 23, 59);
    expect(formatReadTime(today, now)).toBe(`today at ${time(today)}`);
    expect(formatReadTime(yesterday.toISOString(), now)).toBe(`yesterday at ${time(yesterday)}`);
  });

  it("uses a short date for older reads, with the year only when it differs", () => {
    const older = new Date(2026, 9, 2, 9, 0);
    const lastYear = new Date(2025, 11, 31, 9, 0);
    expect(formatReadTime(older, now)).toBe(`${older.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time(older)}`);
    expect(formatReadTime(lastYear, now)).toContain("2025");
  });
});
