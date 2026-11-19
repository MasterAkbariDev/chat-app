import { describe, expect, it } from "vitest";
import { describeCallLog, parseCallLog } from "./call-log";

describe("parseCallLog", () => {
  it("parses a well-formed call-log payload", () => {
    expect(parseCallLog(JSON.stringify({ callLog: true, kind: "ended", durationMinutes: 3 }))).toEqual({
      kind: "ended",
      durationMinutes: 3,
    });
  });

  it("omits durationMinutes when absent", () => {
    expect(parseCallLog(JSON.stringify({ callLog: true, kind: "missed" }))).toEqual({ kind: "missed", durationMinutes: undefined });
  });

  it("returns null for plain text, invalid JSON, or a non-call-log payload", () => {
    expect(parseCallLog("hello")).toBeNull();
    expect(parseCallLog("")).toBeNull();
    expect(parseCallLog(JSON.stringify({ foo: "bar" }))).toBeNull();
    expect(parseCallLog(JSON.stringify({ callLog: true, kind: "not-a-real-kind" }))).toBeNull();
  });
});

describe("describeCallLog", () => {
  it("reads differently for the caller than for everyone else", () => {
    expect(describeCallLog({ kind: "missed" }, true)).toBe("No answer");
    expect(describeCallLog({ kind: "missed" }, false)).toBe("Missed call");
    expect(describeCallLog({ kind: "declined" }, true)).toBe("Call declined");
    expect(describeCallLog({ kind: "declined" }, false)).toBe("You declined");
  });

  it("shows the real duration for a completed call, both directions", () => {
    expect(describeCallLog({ kind: "ended", durationMinutes: 12 }, true)).toBe("Call ended · 12m");
    expect(describeCallLog({ kind: "ended", durationMinutes: 12 }, false)).toBe("Call ended · 12m");
  });

  it("falls back to a plain 'Call ended' when duration wasn't recorded", () => {
    expect(describeCallLog({ kind: "ended" }, true)).toBe("Call ended");
  });
});
