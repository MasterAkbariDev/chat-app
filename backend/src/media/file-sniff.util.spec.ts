import { sniffImageType } from "./file-sniff.util";

describe("sniffImageType", () => {
  it("recognizes a JPEG by its magic bytes", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffImageType(buf)).toEqual({ mimeType: "image/jpeg", ext: "jpg" });
  });

  it("recognizes a PNG by its magic bytes", () => {
    const buf = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
    ]);
    expect(sniffImageType(buf)).toEqual({ mimeType: "image/png", ext: "png" });
  });

  it("recognizes a GIF (GIF89a) by its magic bytes", () => {
    const buf = Buffer.from("GIF89a" + "\0".repeat(6), "binary");
    expect(sniffImageType(buf)).toEqual({ mimeType: "image/gif", ext: "gif" });
  });

  it("recognizes a WEBP (RIFF....WEBP) by its magic bytes", () => {
    const buf = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(sniffImageType(buf)).toEqual({
      mimeType: "image/webp",
      ext: "webp",
    });
  });

  it("rejects a file that merely has an image extension in its (irrelevant) name", () => {
    // The whole point: sniffImageType never sees a filename, only bytes — a renamed .exe/.php
    // masquerading as a .jpg produces no match here.
    const buf = Buffer.from("#!/bin/sh\necho hi\n");
    expect(sniffImageType(buf)).toBeNull();
  });

  it("rejects a too-short buffer instead of reading out of bounds", () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});
