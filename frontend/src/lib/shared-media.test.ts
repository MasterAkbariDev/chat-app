import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/api/types";
import type { SharedItemsPage } from "@/lib/api/profile";
import {
  displayUrl,
  explodeSharedPages,
  groupByMonth,
  hostOf,
  linksIn,
  listResolver,
  monthLabel,
  sharedFileName,
  sharedMusicTrack,
  sharedViewerItems,
} from "./shared-media";

const omid = { _id: "u-omid", username: "omid", firstName: "Omid", lastName: "" } as unknown as ChatMessage["senderId"];

function msg(id: string, fields: Partial<ChatMessage>): ChatMessage {
  return {
    _id: id,
    channelId: "c1",
    senderId: omid,
    content: "",
    type: "image",
    attachments: [],
    attachmentMeta: null,
    replyTo: null,
    replySnapshot: null,
    isEdited: false,
    isPinned: false,
    mentions: [],
    durationSec: null,
    waveform: null,
    originalFilename: null,
    deletedFor: [],
    forwardFrom: null,
    metadata: null,
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T10:00:00.000Z",
    reactions: [],
    packId: null,
    packItemId: null,
    ...fields,
  } as ChatMessage;
}

const meta = (extra: Record<string, unknown> = {}) => ({ mediaId: "m", width: 4, height: 3, blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH", ...extra });

describe("explodeSharedPages", () => {
  const album = msg("album", {
    attachments: ["/a.jpg", "/b.mp4", "/c.jpg"],
    attachmentMeta: { "/a.jpg": meta(), "/b.mp4": meta({ kind: "video", durationSec: 12 }), "/c.jpg": meta() },
    createdAt: "2026-10-05T10:00:00.000Z",
  });
  const photo = msg("photo", { attachments: ["/p.jpg"], createdAt: "2026-09-20T10:00:00.000Z" });

  it("turns item refs into one item per attachment, in the server's order", () => {
    const pages: SharedItemsPage[] = [
      { items: [{ messageId: "album", index: 0 }, { messageId: "album", index: 1 }], messages: [album], nextCursor: "x" },
      { items: [{ messageId: "album", index: 2 }, { messageId: "photo", index: 0 }], messages: [album, photo], nextCursor: null },
    ];
    const items = explodeSharedPages(pages);
    expect(items.map((i) => i.key)).toEqual(["album:0", "album:1", "album:2", "photo:0"]);
    expect(items.map((i) => i.isVideo)).toEqual([false, true, false, false]);
    expect(items[1].url).toBe("/b.mp4");
    expect(items[1].meta?.durationSec).toBe(12);
  });

  it("drops duplicates and refs whose message is missing", () => {
    const pages: SharedItemsPage[] = [
      { items: [{ messageId: "photo", index: 0 }], messages: [photo], nextCursor: "x" },
      { items: [{ messageId: "photo", index: 0 }, { messageId: "gone", index: 0 }], messages: [photo], nextCursor: null },
    ];
    expect(explodeSharedPages(pages).map((i) => i.key)).toEqual(["photo:0"]);
  });

  it("builds the viewer list oldest first with each item's kind", () => {
    const items = explodeSharedPages([
      { items: [0, 1, 2].map((index) => ({ messageId: "album", index })).concat({ messageId: "photo", index: 0 }), messages: [album, photo], nextCursor: null },
    ]);
    const viewer = sharedViewerItems(items, "me");
    expect(viewer.map((v) => v.key)).toEqual(["photo:0", "album:2", "album:1", "album:0"]);
    expect(viewer.map((v) => v.kind)).toEqual(["image", "image", "video", "image"]);
    expect(viewer[0].senderName).toBe("Omid");
    expect(sharedViewerItems(items, "u-omid")[0].senderName).toBe("You");
  });
});

describe("groupByMonth", () => {
  it("sections newest-first items by month with 'October 2026' labels", () => {
    const sections = groupByMonth(
      [{ createdAt: "2026-10-09T12:00:00Z" }, { createdAt: "2026-10-01T12:00:00Z" }, { createdAt: "2026-09-15T12:00:00Z" }, { createdAt: "2025-10-15T12:00:00Z" }],
      "en-US",
    );
    expect(sections.map((s) => [s.label, s.items.length])).toEqual([
      ["October 2026", 2],
      ["September 2026", 1],
      ["October 2025", 1],
    ]);
    expect(monthLabel("not a date")).toBe("");
  });
});

describe("files and music", () => {
  const group = msg("files", {
    type: "file",
    attachments: ["/f1", "/f2", "/f3"],
    originalFilename: "report.pdf",
    attachmentMeta: { "/f2": meta({ kind: "file", fileName: "notes.docx" }), "/f3": meta({ kind: "audio", fileName: "song.mp3", title: "Song", artist: "Band", durationSec: 200 }) },
  });
  const items = explodeSharedPages([{ items: [0, 1, 2].map((index) => ({ messageId: "files", index })), messages: [group], nextCursor: null }]);

  it("names each file of a group", () => {
    expect(items.map(sharedFileName)).toEqual(["report.pdf", "notes.docx", "song.mp3"]);
  });

  it("makes player tracks with the bubble's track ids", () => {
    const t = sharedMusicTrack(items[2], "me");
    expect(t).toMatchObject({ id: "files#2", kind: "music", title: "Song", artist: "Band", durationSec: 200, senderName: "Omid", channelId: "c1" });
  });

  it("walks the tab's list for previous / next", () => {
    const next = listResolver(
      () => items,
      (it) => (it.index === 1 ? null : it.key),
      (it) => it.key,
    );
    expect(next("files:0", 1)).toBe("files:2"); // skips a row with no track
    expect(next("files:2", -1)).toBe("files:0");
    expect(next("files:2", 1)).toBeNull();
    expect(next("nope", 1)).toBeNull();
  });
});

describe("links", () => {
  it("finds each link once, trims trailing punctuation, adds a scheme", () => {
    expect(linksIn("see https://example.com/a, and www.test.org/x). Again https://example.com/a")).toEqual(["https://example.com/a", "https://www.test.org/x"]);
    expect(linksIn("سلام https://fa.wikipedia.org/wiki/تهران خوبی؟")).toEqual(["https://fa.wikipedia.org/wiki/تهران"]);
    expect(linksIn(null)).toEqual([]);
  });

  it("shows hosts and short URLs", () => {
    expect(hostOf("https://www.example.com/a")).toBe("example.com");
    expect(hostOf("not a url")).toBe("not a url");
    expect(displayUrl("https://www.example.com/a/")).toBe("example.com/a");
  });
});
