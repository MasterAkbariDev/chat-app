/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BadRequestException } from "@nestjs/common";

const runFfmpeg = jest.fn();
jest.mock("src/media/video-processing.util", () => {
  const actual = jest.requireActual("src/media/video-processing.util");
  return {
    ...actual,
    runFfmpeg: (...args: unknown[]) => runFfmpeg(...args),
    describeVideoInput: jest.fn(async () => "test"),
  };
});

import { FfmpegError } from "src/media/video-processing.util";
import { GifConversionService } from "./gif-conversion.service";

/** Writes the output file for a successful GIF pass (the last argument), like ffmpeg does. */
function succeedWritingOutput(label: string, args: string[]) {
  if (label === "gif" && args[args.length - 1].endsWith(".gif")) {
    writeFileSync(args[args.length - 1], Buffer.alloc(2048));
  }
  if (label === "plain")
    writeFileSync(args[args.length - 1], Buffer.alloc(4096));
}

describe("GifConversionService", () => {
  let dir: string;
  let input: string;
  let output: string;

  beforeEach(() => {
    runFfmpeg.mockReset();
    dir = mkdtempSync(join(tmpdir(), "gif-test-"));
    input = join(dir, "input.mp4");
    output = join(dir, "out.gif");
    writeFileSync(input, Buffer.from("not really a video"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("converts a clip the GIF filters accept, in two passes", async () => {
    runFfmpeg.mockImplementation(async (label: string, args: string[]) =>
      succeedWritingOutput(label, args),
    );
    await new GifConversionService().convertVideoToGif(input, output);
    expect(existsSync(output)).toBe(true);
    expect(runFfmpeg.mock.calls.map(c => c[0])).toEqual(["gif", "gif"]);
  });

  it("retries from a plain H.264 copy when the GIF filters fail on the original", async () => {
    let failedOnce = false;
    runFfmpeg.mockImplementation(async (label: string, args: string[]) => {
      if (label === "gif" && !failedOnce) {
        failedOnce = true;
        throw new FfmpegError(
          "ffmpeg gif failed",
          "Error parsing filterchain: unsupported pixel format",
          null,
          "ffmpeg",
        );
      }
      succeedWritingOutput(label, args);
    });
    await new GifConversionService().convertVideoToGif(input, output);
    const labels = runFfmpeg.mock.calls.map(c => c[0]);
    expect(labels).toEqual(["gif", "plain", "gif", "gif"]);
    expect(existsSync(output)).toBe(true);
  });

  it("says the video couldn't be read, without the retry, for an unreadable file", async () => {
    runFfmpeg.mockImplementation(async () => {
      throw new FfmpegError(
        "ffmpeg gif failed",
        "Invalid data found when processing input",
        null,
        "ffmpeg",
      );
    });
    await expect(
      new GifConversionService().convertVideoToGif(input, output),
    ).rejects.toThrow("That video couldn't be read");
    expect(runFfmpeg.mock.calls.map(c => c[0])).toEqual(["gif"]);
  });

  it("reports a clip that's too big after the smaller attempts", async () => {
    runFfmpeg.mockImplementation(async (label: string, args: string[]) => {
      if (label === "gif" && args[args.length - 1].endsWith(".gif"))
        writeFileSync(args[args.length - 1], Buffer.alloc(9 * 1024 * 1024));
    });
    await expect(
      new GifConversionService().convertVideoToGif(input, output),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runFfmpeg.mock.calls.map(c => c[0])).not.toContain("plain");
  });
});
