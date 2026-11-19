import { describe, expect, it } from "vitest";
import { applyMessageDeleted, movePinned, pinToTop, sortChannels } from "@/lib/chat-list";
import type { ChannelSummary, ChannelsPage } from "@/lib/api/types";

function chat(id: string, opts: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    channelId: id,
    type: "group",
    name: id,
    image: [],
    link: null,
    myRole: "member",
    isPinned: false,
    isMuted: false,
    lastReadMessageId: null,
    lastMessageAt: "2024-01-01T00:00:00.000Z",
    lastMessagePreview: "hi",
    tags: [],
    unread: false,
    ...opts,
  } as ChannelSummary;
}

describe("applyMessageDeleted", () => {
  const page: ChannelsPage = {
    items: [chat("a", { lastMessageAt: "2024-01-02T00:00:00.000Z", lastMessagePreview: "second", unread: true }), chat("b")],
    nextCursor: null,
  };

  it("falls back to the recomputed previous message", () => {
    const next = applyMessageDeleted(page, { channelId: "a", messageId: "m", lastMessageAt: "2024-01-01T00:00:00.000Z", lastMessagePreview: "first" });
    expect(next).not.toBe(page);
    expect(next!.items[0]).toMatchObject({ lastMessagePreview: "first", lastMessageAt: "2024-01-01T00:00:00.000Z", unread: true });
    expect(next!.items[1]).toBe(page.items[1]);
  });

  it("clears preview and unread when nothing is left", () => {
    const next = applyMessageDeleted(page, { channelId: "a", messageId: "m", lastMessageAt: null, lastMessagePreview: null });
    expect(next!.items[0]).toMatchObject({ lastMessagePreview: null, lastMessageAt: null, unread: false });
  });

  it("is a no-op when an older message was deleted, or without a summary", () => {
    expect(applyMessageDeleted(page, { channelId: "a", messageId: "m", lastMessageAt: "2024-01-02T00:00:00.000Z", lastMessagePreview: "second" })).toBe(page);
    expect(applyMessageDeleted(page, { channelId: "a", messageId: "m" })).toBe(page);
    expect(applyMessageDeleted(page, { channelId: "zzz", messageId: "m", lastMessageAt: null, lastMessagePreview: null })).toBe(page);
  });
});

describe("pinned ordering", () => {
  const items = [
    chat("p1", { isPinned: true, lastMessageAt: "2024-01-01T00:00:00.000Z" }),
    chat("x", { lastMessageAt: "2024-01-05T00:00:00.000Z" }),
    chat("p2", { isPinned: true, lastMessageAt: "2024-01-09T00:00:00.000Z" }),
    chat("y", { lastMessageAt: "2024-01-07T00:00:00.000Z" }),
  ];

  it("sortChannels keeps pinned order (not recency) and sorts the rest by recency", () => {
    expect(sortChannels(items).map((c) => c.channelId)).toEqual(["p1", "p2", "y", "x"]);
  });

  it("movePinned reorders only the pinned chats", () => {
    const moved = movePinned(items, "p2", 0)!;
    expect(moved.order).toEqual(["p2", "p1"]);
    expect(sortChannels(moved.items).map((c) => c.channelId)).toEqual(["p2", "p1", "y", "x"]);
    expect(movePinned(items, "p1", 0)).toBeNull();
    expect(movePinned(items, "x", 0)).toBeNull();
    expect(movePinned(items, "p1", 99)!.order).toEqual(["p2", "p1"]);
  });

  it("pinToTop puts a newly pinned chat first", () => {
    expect(sortChannels(pinToTop(items, "y")).map((c) => c.channelId)).toEqual(["y", "p1", "p2", "x"]);
  });
});
