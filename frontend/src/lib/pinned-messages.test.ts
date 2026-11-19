import { describe, expect, it } from "vitest";
import { pinPreview, pinSnippet } from "@/lib/pinned-messages";
import type { AttachmentMeta } from "@/lib/api/types";

type Input = Parameters<typeof pinPreview>[0];

function msg(over: Partial<Input> & Pick<Input, "type">): Input {
  return { content: "", senderId: "u1", metadata: null, attachments: [], ...over };
}

const meta = (m: Partial<AttachmentMeta>): AttachmentMeta => ({
  mediaId: "m",
  width: null,
  height: null,
  blurhash: null,
  ...m,
});

describe("pinPreview", () => {
  it("reads plain text, collapsing whitespace, and falls back to Message", () => {
    expect(pinPreview(msg({ type: "text", content: "  سلام\n  دنیا  " }))).toEqual({ kind: "text", label: null, text: "سلام دنیا" });
    expect(pinPreview(msg({ type: "text", content: "   " })).text).toBe("Message");
  });

  it("labels a single photo and video, with the caption", () => {
    expect(pinPreview(msg({ type: "image", content: "beach", attachments: ["a.jpg"] }))).toEqual({ kind: "photo", label: "Photo", text: "beach" });
    expect(pinPreview(msg({ type: "video", attachments: ["a.mp4"] }))).toEqual({ kind: "video", label: "Video", text: "" });
  });

  it("labels an album by its count", () => {
    expect(pinPreview(msg({ type: "image", attachments: ["a.jpg", "b.jpg"] })).label).toBe("Album");
    expect(pinPreview(msg({ type: "video", attachments: ["a.mp4", "b.mp4"] })).label).toBe("Album");
  });

  it("names a single file, and counts a group of files", () => {
    expect(
      pinPreview(msg({ type: "file", attachments: ["r.pdf"], attachmentMeta: { "r.pdf": meta({ fileName: "report.pdf" }) } })).label,
    ).toBe("File: report.pdf");
    expect(pinPreview(msg({ type: "file", attachments: ["r.pdf"], originalFilename: "old.pdf" })).label).toBe("File: old.pdf");
    expect(pinPreview(msg({ type: "file", attachments: ["a", "b", "c"] })).label).toBe("3 files");
  });

  it("uses the track title and artist for music", () => {
    const music = msg({ type: "audio", attachments: ["s.mp3"], attachmentMeta: { "s.mp3": meta({ title: "Nights", artist: "Ali" }) } });
    expect(pinPreview(music).label).toBe("Ali – Nights");
    expect(pinPreview(msg({ type: "audio", attachments: ["s.mp3"] })).label).toBe("Music");
  });

  it("labels voice, video notes, GIFs and stickers", () => {
    expect(pinPreview(msg({ type: "voice" })).label).toBe("Voice message");
    expect(pinPreview(msg({ type: "video_note" })).label).toBe("Video message");
    expect(pinPreview(msg({ type: "gif" })).label).toBe("GIF");
    expect(pinPreview(msg({ type: "sticker" })).label).toBe("Sticker");
  });

  it("drops the leading emoji from call and system lines", () => {
    const sys = pinPreview(msg({ type: "system", content: "x", metadata: { senderName: "Omid" } }), "u2");
    expect(sys.label).toBeNull();
    expect(sys.text.startsWith("📞")).toBe(false);
    expect(sys.text.length).toBeGreaterThan(0);
  });
});

describe("pinSnippet", () => {
  it("joins the label and the caption with a dot", () => {
    expect(pinSnippet(msg({ type: "image", content: "beach", attachments: ["a.jpg"] }))).toBe("Photo · beach");
    expect(pinSnippet(msg({ type: "voice" }))).toBe("Voice message");
    expect(pinSnippet(msg({ type: "text", content: "hi" }))).toBe("hi");
  });
});
