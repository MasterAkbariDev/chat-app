import { describe, expect, it } from "vitest";
import { formatLastSeen, presenceStatus } from "./last-seen";

describe("presenceStatus", () => {
  it("online beats everything", () => {
    expect(presenceStatus({ isOnline: true, lastSeen: null })).toEqual({ text: "online", online: true });
  });
  it("exact time when known", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(presenceStatus({ isOnline: false, lastSeen: iso })?.text).toBe("last seen 5m ago");
  });
  it("Telegram's approximations when hidden", () => {
    expect(presenceStatus({ isOnline: false, lastSeen: null, lastSeenBucket: "recently" })?.text).toBe("last seen recently");
    expect(presenceStatus({ isOnline: false, lastSeen: null, lastSeenBucket: "within_week" })?.text).toBe("last seen within a week");
    expect(presenceStatus({ isOnline: false, lastSeen: null, lastSeenBucket: "within_month" })?.text).toBe("last seen within a month");
    expect(presenceStatus({ isOnline: false, lastSeen: null, lastSeenBucket: "long_ago" })?.text).toBe("last seen a long time ago");
  });
  it("nothing known yet → null", () => {
    expect(presenceStatus(undefined)).toBeNull();
  });
  it("formatLastSeen buckets minutes/hours", () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    expect(formatLastSeen("2026-10-08T11:59:50Z", now)).toBe("last seen just now");
    expect(formatLastSeen("2026-10-08T09:00:00Z", now)).toBe("last seen 3h ago");
  });
});
