import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { AttachmentMeta, ChatMessage } from "@/lib/api/types";
import { messagesKey } from "@/lib/messages-query";
import { chatMusicResolver, musicTracksFrom } from "@/lib/music";
import { MediaAlbum } from "./MediaAlbum";
import { mediaItemsFrom } from "./MediaViewer";
import { FileSendDialog } from "./FileSendDialog";

const meta = (m: Partial<AttachmentMeta>): AttachmentMeta => ({ mediaId: "x", width: 1280, height: 720, blurhash: null, ...m });

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    _id: "m1",
    channelId: "c1",
    senderId: "u1",
    content: "",
    type: "image",
    attachments: [],
    attachmentMeta: null,
    createdAt: "2026-10-08T10:00:00.000Z",
    durationSec: null,
    ...over,
  } as ChatMessage;
}

describe("mixed albums", () => {
  const attachments = ["/uploads/media/a/original.jpg", "/uploads/media/b/original.mp4", "/uploads/media/c/original.jpg"];
  const attachmentMeta = {
    [attachments[0]]: meta({}),
    [attachments[1]]: meta({ kind: "video", durationSec: 75, posterUrl: "/uploads/media/b/poster.jpg" }),
    [attachments[2]]: meta({ width: 720, height: 1280 }),
  };

  it("renders one cell per item, video cells with a length badge, and opens the tapped one", () => {
    const onOpen = vi.fn();
    render(<MediaAlbum type="image" attachments={attachments} meta={attachmentMeta} senderLabel="Maya" onOpen={onOpen} />);
    const video = screen.getByRole("button", { name: "Open video 2 of 3 from Maya" });
    expect(video.textContent).toContain("1:15");
    fireEvent.click(video);
    expect(onOpen).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "Open photo 3 of 3 from Maya" })).toBeTruthy();
  });

  it("gives the viewer each attachment's own kind and length", () => {
    const items = mediaItemsFrom([msg({ attachments, attachmentMeta })]);
    expect(items.map((i) => i.kind)).toEqual(["image", "video", "image"]);
    expect(items[1].durationSec).toBe(75);
  });
});

describe("music groups", () => {
  const a = msg({
    _id: "m1",
    type: "audio",
    attachments: ["/u/one.mp3", "/u/two.mp3"],
    attachmentMeta: { "/u/one.mp3": meta({ kind: "audio", title: "One" }), "/u/two.mp3": meta({ kind: "audio", fileName: "two.mp3" }) },
  });
  const b = msg({ _id: "m2", type: "audio", attachments: ["/u/three.mp3"], originalFilename: "three.mp3" });

  it("turns every row into its own player track", () => {
    const tracks = musicTracksFrom(a, "u1");
    expect(tracks.map((t) => [t.id, t.title])).toEqual([
      ["m1", "One"],
      ["m1#1", "two"],
    ]);
  });

  it("plays a group's tracks in order, then the chat's next music", () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey("c1"), [a, b]);
    const next = chatMusicResolver(qc, "c1", "u1");
    expect(next("m1", 1)?.id).toBe("m1#1");
    expect(next("m1#1", 1)?.id).toBe("m2");
    expect(next("m2", -1)?.id).toBe("m1#1");
    expect(next("m2", 1)).toBeNull();
  });
});

describe("file send sheet", () => {
  it("sends the remaining files with the caption", () => {
    const onSend = vi.fn();
    const files = [new File(["a"], "a.pdf"), new File(["b"], "b.zip"), new File(["c"], "c.txt")];
    render(<FileSendDialog files={files} mode="file" onClose={() => {}} onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove b.zip" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Caption" }), { target: { value: "  گزارش ماهانه " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    const [sent, mode, caption] = onSend.mock.calls[0];
    expect((sent as File[]).map((f) => f.name)).toEqual(["a.pdf", "c.txt"]);
    expect(mode).toBe("file");
    expect(caption).toBe("گزارش ماهانه");
  });
});
