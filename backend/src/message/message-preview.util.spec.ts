import { MessageType } from "src/enum/base.enum";
import { buildMessagePreview } from "./message-preview.util";

describe("buildMessagePreview — files and music", () => {
  it("names the file", () => {
    expect(
      buildMessagePreview({
        type: MessageType.FILE,
        originalFilename: "Report.pdf",
      }),
    ).toBe("📎 Report.pdf");
    expect(buildMessagePreview({ type: MessageType.FILE })).toBe("📎 File");
  });

  it("shows artist – title for music, else the file name", () => {
    expect(
      buildMessagePreview({
        type: MessageType.AUDIO,
        originalFilename: "song.mp3",
        attachmentMeta: { u: { title: "غروب", artist: "The Testers" } },
      }),
    ).toBe("🎵 The Testers – غروب");
    expect(
      buildMessagePreview({
        type: MessageType.AUDIO,
        attachmentMeta: { u: { title: "Sunset", artist: null } },
      }),
    ).toBe("🎵 Sunset");
    expect(
      buildMessagePreview({
        type: MessageType.AUDIO,
        originalFilename: "song.mp3",
      }),
    ).toBe("🎵 song.mp3");
    expect(buildMessagePreview({ type: MessageType.AUDIO })).toBe("🎵 Music");
  });

  it("summarises albums, file groups and music groups, preferring the caption", () => {
    expect(
      buildMessagePreview({ type: MessageType.IMAGE, attachments: ["a", "b"] }),
    ).toBe("🖼 Album");
    expect(
      buildMessagePreview({
        type: MessageType.IMAGE,
        attachments: ["a", "b", "c"],
        content: "سفر  شمال\nday 1",
      }),
    ).toBe("🖼 سفر شمال day 1");
    expect(
      buildMessagePreview({ type: MessageType.IMAGE, attachments: ["a"] }),
    ).toBe("📷 Photo");
    expect(
      buildMessagePreview({ type: MessageType.VIDEO, attachments: ["a", "b"] }),
    ).toBe("🖼 Album");
    expect(
      buildMessagePreview({
        type: MessageType.FILE,
        attachments: ["a", "b", "c"],
        originalFilename: "a.pdf",
      }),
    ).toBe("📎 3 files");
    expect(
      buildMessagePreview({
        type: MessageType.FILE,
        attachments: ["a"],
        originalFilename: "a.pdf",
        content: "گزارش",
      }),
    ).toBe("📎 گزارش");
    expect(
      buildMessagePreview({ type: MessageType.AUDIO, attachments: ["a", "b"] }),
    ).toBe("🎵 2 songs");
  });
});
