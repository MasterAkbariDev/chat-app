import { describe, expect, it } from "vitest";
import { parseSearchQuery, wantsUsernameHint } from "./use-global-search";

describe("wantsUsernameHint", () => {
  it("explains @username search when a name query finds nobody", () => {
    expect(wantsUsernameHint("Zahra Karimi", 0)).toBe(true);
    expect(wantsUsernameHint("  reza ", 0)).toBe(true);
  });

  it("stays quiet when people were found, for @handles, or for too-short queries", () => {
    expect(wantsUsernameHint("Zahra", 1)).toBe(false);
    expect(wantsUsernameHint("@zahra", 0)).toBe(false);
    expect(wantsUsernameHint("z", 0)).toBe(false);
    expect(wantsUsernameHint("", 0)).toBe(false);
  });
});

describe("parseSearchQuery", () => {
  it("drops a leading @ for the server and flags handle mode", () => {
    expect(parseSearchQuery(" @maya ")).toMatchObject({ apiQuery: "maya", isHandle: true });
    expect(parseSearchQuery("maya")).toMatchObject({ apiQuery: "maya", isHandle: false });
  });
});
