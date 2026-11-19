import { sanitizeMessageContent } from "./message-sanitize.util";

describe("sanitizeMessageContent", () => {
  it("keeps normal text untouched", () => {
    expect(sanitizeMessageContent("hello world")).toBe("hello world");
  });

  it("keeps tab, newline, and carriage return", () => {
    expect(sanitizeMessageContent("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("strips other C0 control characters", () => {
    const withControls = "hi\x00\x01\x07there";
    expect(sanitizeMessageContent(withControls)).toBe("hithere");
  });

  it("strips DEL (0x7F)", () => {
    expect(sanitizeMessageContent("abc\x7Fdef")).toBe("abcdef");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeMessageContent("  hello  ")).toBe("hello");
  });

  it("preserves emoji and other multi-byte unicode", () => {
    expect(sanitizeMessageContent("hi 👍 there")).toBe("hi 👍 there");
  });
});
