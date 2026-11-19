import { describe, expect, it } from "vitest";
import { describeSystemMessage, wallpaperChangeMetadata } from "./system-message";

describe("describeSystemMessage", () => {
  it("attributes member_joined to the acting user", () => {
    expect(describeSystemMessage({ content: "member_joined", metadata: null }, "You")).toBe("You joined the chat");
    expect(describeSystemMessage({ content: "member_joined", metadata: null }, "Alice")).toBe("Alice joined the chat");
  });

  it("pluralizes members_added by the real addedUserIds count", () => {
    expect(describeSystemMessage({ content: "members_added", metadata: { addedUserIds: ["a"] } }, "You")).toBe("You added 1 member");
    expect(describeSystemMessage({ content: "members_added", metadata: { addedUserIds: ["a", "b", "c"] } }, "You")).toBe(
      "You added 3 members",
    );
  });

  it("treats a missing or malformed addedUserIds as zero rather than throwing", () => {
    expect(describeSystemMessage({ content: "members_added", metadata: null }, "You")).toBe("You added 0 members");
    expect(describeSystemMessage({ content: "members_added", metadata: { addedUserIds: "not-an-array" } }, "You")).toBe(
      "You added 0 members",
    );
  });

  it("describes a wallpaper change", () => {
    expect(describeSystemMessage({ content: "wallpaper_changed", metadata: null }, "Alice")).toBe("Alice changed the chat wallpaper");
  });

  it("falls back to the raw content for an unrecognized code", () => {
    expect(describeSystemMessage({ content: "some_future_event", metadata: null }, "You")).toBe("some_future_event");
  });
});

describe("wallpaperChangeMetadata", () => {
  it("extracts the wallpaperId for a real wallpaper_changed message", () => {
    expect(wallpaperChangeMetadata({ content: "wallpaper_changed", metadata: { wallpaperId: "wp1" } })).toEqual({ wallpaperId: "wp1" });
  });

  it("returns null for any other content, even with a wallpaperId-shaped metadata", () => {
    expect(wallpaperChangeMetadata({ content: "members_added", metadata: { wallpaperId: "wp1" } })).toBeNull();
  });

  it("returns null when wallpaperId is missing or not a string", () => {
    expect(wallpaperChangeMetadata({ content: "wallpaper_changed", metadata: null })).toBeNull();
    expect(wallpaperChangeMetadata({ content: "wallpaper_changed", metadata: { wallpaperId: 123 } })).toBeNull();
  });
});
