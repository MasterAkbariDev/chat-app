import { describe, expect, it } from "vitest";
import { ruleSummary } from "./privacy-meta";

describe("ruleSummary", () => {
  it("shows only the exception lists that apply to the audience", () => {
    expect(ruleSummary({ audience: "everybody", allow: [1, 2], deny: [] })).toBe("Everybody");
    expect(ruleSummary({ audience: "everybody", allow: [], deny: [1] })).toBe("Everybody (−1)");
    expect(ruleSummary({ audience: "nobody", allow: [1, 2], deny: [3] })).toBe("Nobody (+2)");
    expect(ruleSummary({ audience: "contacts", allow: [1, 2], deny: [3] })).toBe("My contacts (−1, +2)");
    expect(ruleSummary({ audience: "contacts", allow: [], deny: [] })).toBe("My contacts");
  });
});
