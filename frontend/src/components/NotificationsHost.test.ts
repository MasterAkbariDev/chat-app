import { describe, expect, it } from "vitest";
import { isChatListPath, shouldToast, type ToastContext } from "./NotificationsHost";

const base: ToastContext = { enabled: true, own: false, inOpenChat: false, onChatList: false, tabHidden: false, muted: false };

describe("shouldToast", () => {
  it("toasts a new message while you're in another chat or on another screen", () => {
    expect(shouldToast(base)).toBe(true);
  });

  it("stays silent when in-app notifications are switched off in Settings", () => {
    expect(shouldToast({ ...base, enabled: false })).toBe(false);
  });

  it("stays silent for your own messages", () => {
    expect(shouldToast({ ...base, own: true })).toBe(false);
  });

  it("stays silent in the chat you're reading", () => {
    expect(shouldToast({ ...base, inOpenChat: true })).toBe(false);
  });

  it("stays silent on the chat list: the row already shows the message", () => {
    expect(shouldToast({ ...base, onChatList: true })).toBe(false);
  });

  it("stays silent while the tab is hidden (the title count and push cover it)", () => {
    expect(shouldToast({ ...base, tabHidden: true })).toBe(false);
  });

  it("stays silent for a muted chat", () => {
    expect(shouldToast({ ...base, muted: true })).toBe(false);
  });
});

describe("isChatListPath", () => {
  it("is the list route only", () => {
    expect(isChatListPath("/app")).toBe(true);
    expect(isChatListPath("/app/")).toBe(true);
    expect(isChatListPath("/app/c/123")).toBe(false);
    expect(isChatListPath("/app/settings")).toBe(false);
    expect(isChatListPath(null)).toBe(false);
  });
});
