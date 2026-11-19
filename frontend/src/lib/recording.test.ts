import { describe, expect, it } from "vitest";
import { describeMediaError, downsampleWaveform, extensionForMime, formatDuration } from "./recording";

describe("recording helpers", () => {
  it("formats durations as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(7.9)).toBe("0:07");
    expect(formatDuration(65)).toBe("1:05");
  });

  it("downsamples to the requested bar count, normalised to the loudest bar", () => {
    const bars = downsampleWaveform([0.1, 0.2, 0.4, 0.2, 0.1, 0.05], 3);
    expect(bars).toHaveLength(3);
    expect(Math.max(...bars)).toBe(1);
    expect(bars.every((b) => b >= 0.06 && b <= 1)).toBe(true);
  });

  it("returns a flat placeholder for an empty recording", () => {
    expect(downsampleWaveform([], 4)).toEqual([0.08, 0.08, 0.08, 0.08]);
  });

  it("picks a file extension from the recorder's mime type", () => {
    expect(extensionForMime("audio/mp4;codecs=mp4a.40.2")).toBe("m4a");
    expect(extensionForMime("video/mp4")).toBe("mp4");
    expect(extensionForMime("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionForMime("audio/ogg")).toBe("ogg");
  });

  it("explains a blocked device in plain language", () => {
    expect(describeMediaError(new DOMException("x", "NotAllowedError"), "voice")).toMatch(/microphone is blocked/);
    expect(describeMediaError(new DOMException("x", "NotFoundError"), "video")).toMatch(/No camera and microphone/);
  });
});
