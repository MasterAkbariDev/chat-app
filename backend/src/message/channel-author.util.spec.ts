import { ChatType } from "src/enum/base.enum";
import {
  channelSenderView,
  isChannelChat,
  maskChannelMessage,
  signatureFor,
} from "./channel-author.util";

describe("channel author rules", () => {
  const channel = {
    name: "News",
    image: ["https://x/p.png"],
    signature: false,
  };
  const adminPost = {
    _id: "m1",
    content: "Hello",
    senderId: {
      _id: "admin-id",
      username: "boss",
      firstName: "Ada",
      lastName: "Lovelace",
    },
  };

  it("shows the channel, not the admin, when signatures are off", () => {
    const out = maskChannelMessage(adminPost, "ch1", channel, "Ada Lovelace");
    expect(out.senderId).toEqual({
      _id: "ch1",
      username: "",
      firstName: "News",
      lastName: "",
      avatarUrl: ["https://x/p.png"],
    });
    expect(out.signature).toBeNull();
    expect(JSON.stringify(out)).not.toContain("admin-id");
    expect(JSON.stringify(out)).not.toContain("boss");
  });

  it("adds only the author's name when signatures are on", () => {
    const out = maskChannelMessage(
      adminPost,
      "ch1",
      { ...channel, signature: true },
      "Ada Lovelace",
    );
    expect(out.signature).toBe("Ada Lovelace");
    expect(JSON.stringify(out.senderId)).not.toContain("admin-id");
    expect(JSON.stringify(out.senderId)).not.toContain("boss");
  });

  it("signatureFor is null unless the channel signs", () => {
    expect(signatureFor(channel, "Ada")).toBeNull();
    expect(signatureFor({ ...channel, signature: true }, "Ada")).toBe("Ada");
  });

  it("channelSenderView tolerates a missing photo", () => {
    expect(
      channelSenderView("ch1", { name: "News", image: null }).avatarUrl,
    ).toEqual([]);
  });

  it("recognises only channels", () => {
    expect(isChannelChat({ type: ChatType.CHANNEL })).toBe(true);
    expect(isChannelChat({ type: ChatType.GROUP })).toBe(false);
    expect(isChannelChat(null)).toBe(false);
  });
});
