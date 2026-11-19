import { describe, expect, it } from "vitest";
import { buildMessagePreview } from "./message-preview";

const sender = { _id: "u1", username: "alice", firstName: "Alice", lastName: "", avatarUrl: [], bio: "" };

describe("buildMessagePreview", () => {
  it("maps each non-text type to a fixed label", () => {
    expect(buildMessagePreview({ type: "image", content: "", senderId: sender, metadata: null })).toBe("📷 Photo");
    expect(buildMessagePreview({ type: "file", content: "", senderId: sender, metadata: null })).toBe("📎 File");
    expect(buildMessagePreview({ type: "voice", content: "", senderId: sender, metadata: null })).toBe("🎤 Voice message");
    expect(buildMessagePreview({ type: "video", content: "", senderId: sender, metadata: null })).toBe("🎬 Video");
    expect(buildMessagePreview({ type: "video_note", content: "", senderId: sender, metadata: null })).toBe("📹 Video message");
    expect(buildMessagePreview({ type: "gif", content: "", senderId: sender, metadata: null })).toBe("GIF");
    expect(buildMessagePreview({ type: "sticker", content: "", senderId: sender, metadata: null })).toBe("Sticker");
    expect(buildMessagePreview({ type: "voice_call", content: "", senderId: sender, metadata: null })).toBe("📞 Call");
  });

  it("names the file, and the track (artist – title) for music", () => {
    expect(buildMessagePreview({ type: "file", content: "", senderId: sender, metadata: null, originalFilename: "Report.pdf" })).toBe("📎 Report.pdf");
    const meta = { "/uploads/media/a/audio.mp3": { mediaId: "m", width: null, height: null, blurhash: null, title: "Sunset", artist: "The Testers" } };
    expect(buildMessagePreview({ type: "audio", content: "", senderId: sender, metadata: null, attachmentMeta: meta })).toBe("🎵 The Testers – Sunset");
    expect(buildMessagePreview({ type: "audio", content: "", senderId: sender, metadata: null, originalFilename: "song.mp3" })).toBe("🎵 song.mp3");
    expect(buildMessagePreview({ type: "audio", content: "", senderId: sender, metadata: null })).toBe("🎵 Music");
  });

  it("passes plain text through, trimmed", () => {
    expect(buildMessagePreview({ type: "text", content: "  hi there  ", senderId: sender, metadata: null })).toBe("hi there");
  });

  it("returns an empty string for blank text rather than a stray ellipsis", () => {
    expect(buildMessagePreview({ type: "text", content: "   ", senderId: sender, metadata: null })).toBe("");
  });

  it("truncates long text at 120 chars with an ellipsis", () => {
    const long = "a".repeat(140);
    const preview = buildMessagePreview({ type: "text", content: long, senderId: sender, metadata: null });
    expect(preview).toBe(`${"a".repeat(120)}…`);
    expect(preview.length).toBe(121);
  });

  it("does not truncate text at exactly 120 chars", () => {
    const exact = "a".repeat(120);
    expect(buildMessagePreview({ type: "text", content: exact, senderId: sender, metadata: null })).toBe(exact);
  });

  it("attributes a system message to 'You' only for the viewer's own action", () => {
    expect(
      buildMessagePreview({ type: "system", content: "member_joined", senderId: sender, metadata: null }, "u1"),
    ).toBe("You joined the chat");
    expect(
      buildMessagePreview({ type: "system", content: "member_joined", senderId: sender, metadata: null }, "someone-else"),
    ).toBe("Alice joined the chat");
  });

  it("falls back to the sender's name when no viewer id is given at all", () => {
    expect(buildMessagePreview({ type: "system", content: "member_joined", senderId: sender, metadata: null })).toBe(
      "Alice joined the chat",
    );
  });

  it("describes a voice_call message's real outcome once its content parses as a call log", () => {
    const missed = JSON.stringify({ callLog: true, kind: "missed" });
    const ended = JSON.stringify({ callLog: true, kind: "ended", durationMinutes: 4 });
    // sender ("u1") is always the call's initiator (finalizeCall posts it that way) —
    // "u1" viewing it is the caller, "someone-else" is the other party.
    expect(buildMessagePreview({ type: "voice_call", content: missed, senderId: sender, metadata: null }, "u1")).toBe("📞 No answer");
    expect(buildMessagePreview({ type: "voice_call", content: missed, senderId: sender, metadata: null }, "someone-else")).toBe(
      "📞 Missed call",
    );
    expect(buildMessagePreview({ type: "voice_call", content: ended, senderId: sender, metadata: null }, "someone-else")).toBe(
      "📞 Call ended · 4m",
    );
  });
});

describe("buildMessagePreview — albums, groups, captions", () => {
  const base = { content: "", senderId: "u1", metadata: null } as const;
  it("summarises albums and file groups, preferring a caption", () => {
    expect(buildMessagePreview({ ...base, type: "image", attachments: ["a", "b"] })).toBe("🖼 Album");
    expect(buildMessagePreview({ ...base, type: "file", attachments: ["a", "b", "c"] })).toBe("📎 3 files");
    expect(buildMessagePreview({ ...base, type: "file", attachments: ["a", "b", "c"], content: "گزارش ماهانه" })).toBe("📎 گزارش ماهانه");
    expect(buildMessagePreview({ ...base, type: "audio", attachments: ["a", "b"] })).toBe("🎵 2 songs");
  });
});
