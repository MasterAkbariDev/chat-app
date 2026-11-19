import { contentTypeFor, parseRange } from "./media-serve.controller";

describe("parseRange (B11: byte-range parsing for media serving)", () => {
  const SIZE = 1000;

  it("parses a normal bounded range", () => {
    expect(parseRange("bytes=0-99", SIZE)).toEqual({ start: 0, end: 99 });
  });

  it("parses an open-ended range (to the end of the file)", () => {
    expect(parseRange("bytes=500-", SIZE)).toEqual({ start: 500, end: 999 });
  });

  it("parses a suffix range (last N bytes)", () => {
    expect(parseRange("bytes=-100", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("clamps a suffix range longer than the file to the whole file", () => {
    expect(parseRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("clamps an end beyond the file size to the last byte", () => {
    expect(parseRange("bytes=990-99999", SIZE)).toEqual({
      start: 990,
      end: 999,
    });
  });

  it("returns null for no header", () => {
    expect(parseRange(undefined, SIZE)).toBeNull();
  });

  it("returns null for a malformed header", () => {
    expect(parseRange("not-a-range", SIZE)).toBeNull();
  });

  it("returns null for a multi-range header (unsupported form)", () => {
    expect(parseRange("bytes=0-10,20-30", SIZE)).toBeNull();
  });

  it("returns null when start is beyond the file size", () => {
    expect(parseRange("bytes=5000-6000", SIZE)).toBeNull();
  });

  it("returns null when start > end", () => {
    expect(parseRange("bytes=500-100", SIZE)).toBeNull();
  });

  it("returns null for a negative-looking malformed start", () => {
    expect(parseRange("bytes=-", SIZE)).toBeNull();
  });
});

describe("contentTypeFor (B11: media-serve content-type inference)", () => {
  it.each([
    ["a/b/c.jpg", "image/jpeg"],
    ["a/b/c.jpeg", "image/jpeg"],
    ["a/b/c.png", "image/png"],
    ["a/b/c.webp", "image/webp"],
    ["a/b/c.gif", "image/gif"],
    ["a/b/c.mp4", "video/mp4"],
    ["a/b/c.PNG", "image/png"],
    ["a/b/c.unknownext", "application/octet-stream"],
    ["a/b/c", "application/octet-stream"],
  ])("%s -> %s", (path, expected) => {
    expect(contentTypeFor(path)).toBe(expected);
  });
});
