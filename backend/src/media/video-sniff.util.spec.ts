import { sniffVideoType } from "./video-sniff.util";

describe("sniffVideoType", () => {
  it("returns null for a buffer with no recognizable signature", () => {
    expect(sniffVideoType(Buffer.from("just some text"))).toBeNull();
    expect(sniffVideoType(Buffer.alloc(4))).toBeNull();
  });

  it("recognizes an mp4 ftyp box", () => {
    const buf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]), // box size
      Buffer.from("ftyp", "ascii"),
      Buffer.from("isom", "ascii"), // major brand
      Buffer.alloc(4),
    ]);
    expect(sniffVideoType(buf)).toEqual({ mimeType: "video/mp4", ext: "mp4" });
  });

  it("recognizes a mov ftyp box (qt major brand)", () => {
    const buf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x14]),
      Buffer.from("ftyp", "ascii"),
      Buffer.from("qt  ", "ascii"),
      Buffer.alloc(4),
    ]);
    expect(sniffVideoType(buf)).toEqual({
      mimeType: "video/quicktime",
      ext: "mov",
    });
  });

  it("recognizes a webm/mkv EBML header", () => {
    const buf = Buffer.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(sniffVideoType(buf)).toEqual({
      mimeType: "video/webm",
      ext: "webm",
    });
  });

  it("recognizes an AVI RIFF container", () => {
    const buf = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("AVI ", "ascii"),
    ]);
    expect(sniffVideoType(buf)).toEqual({
      mimeType: "video/x-msvideo",
      ext: "avi",
    });
  });

  it("does not misidentify a WebP (RIFF....WEBP) as a video", () => {
    const buf = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(sniffVideoType(buf)).toBeNull();
  });
});
