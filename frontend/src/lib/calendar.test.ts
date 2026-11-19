import { describe, expect, it } from "vitest";
import { addDays, addMonths, clampYmd, endOfWeek, gregorianLocale, inRange, monthGrid, parseYmd, startOfWeek, todayYmd, weekStartFor } from "./calendar";

describe("calendar helpers", () => {
  it("parses only real YYYY-MM-DD dates", () => {
    expect(parseYmd("2026-10-06")).toEqual({ y: 2026, m: 9, d: 6 });
    expect(parseYmd("2026-02-30")).toBeNull();
    expect(parseYmd("2026-13-01")).toBeNull();
    expect(parseYmd("")).toBeNull();
    expect(parseYmd(null)).toBeNull();
  });

  it("does day arithmetic across months, years and leap days", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-03-29", 7)).toBe("2026-04-05");
  });

  it("clamps month arithmetic to the target month's length", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonths("2026-10-06", 12)).toBe("2027-10-06");
  });

  it("finds week bounds for any week start", () => {
    // 2026-10-06 is a Tuesday.
    expect(startOfWeek("2026-10-06", 0)).toBe("2026-10-04");
    expect(startOfWeek("2026-10-06", 1)).toBe("2026-10-05");
    expect(startOfWeek("2026-10-06", 6)).toBe("2026-10-03");
    expect(endOfWeek("2026-10-06", 6)).toBe("2026-10-09");
  });

  it("builds a six-week grid that contains the whole month", () => {
    const grid = monthGrid(2026, 1, 1); // February 2026, Monday start
    expect(grid).toHaveLength(6);
    expect(grid.every((w) => w.length === 7)).toBe(true);
    const flat = grid.flat();
    expect(flat[0]).toBe("2026-01-26");
    expect(flat).toContain("2026-02-01");
    expect(flat).toContain("2026-02-28");
  });

  it("clamps and range-checks", () => {
    expect(clampYmd("2026-11-01", null, "2026-10-06")).toBe("2026-10-06");
    expect(clampYmd("2020-01-01", "2021-01-01", null)).toBe("2021-01-01");
    expect(inRange("2026-10-06", "2026-10-06", "2026-10-06")).toBe(true);
    expect(inRange("2026-10-07", null, "2026-10-06")).toBe(false);
  });

  it("uses the local calendar date for today", () => {
    // 00:30 local is still today locally, whatever UTC says.
    expect(todayYmd(new Date(2026, 9, 6, 0, 30))).toBe("2026-10-06");
  });

  it("knows each locale's first day of the week", () => {
    expect(weekStartFor("en-US")).toBe(0);
    expect(weekStartFor("en-GB")).toBe(1);
    expect(weekStartFor("fa-IR")).toBe(6);
    expect(weekStartFor("de")).toBe(1);
  });

  it("pins locales to the Gregorian calendar", () => {
    expect(gregorianLocale("fa-IR")).toContain("ca-gregory");
    const month = new Intl.DateTimeFormat(gregorianLocale("fa-IR"), { month: "numeric" }).format(new Date(2026, 9, 6, 12));
    expect(month.replace(/[۰-۹]/g, (c) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)))).toBe("10");
  });
});
