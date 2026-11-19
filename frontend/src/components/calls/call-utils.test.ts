import { describe, expect, it } from "vitest";
import {
  AUTO_TIMING,
  autoStep,
  bitrateForHeight,
  deviceLabel,
  formatDuration,
  formatVideoStats,
  gridShape,
  initialAutoState,
  layerPlan,
  levelNeed,
  nearestCorner,
  parseParticipantMeta,
  pickLayout,
  readSendHealth,
  readVideoStats,
  recvCapStep,
  startLevel,
  type AutoState,
  type SendHealth,
} from "./call-utils";

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3600 + 2 * 60 + 3)).toBe("1:02:03");
  });
});

describe("parseParticipantMeta", () => {
  it("reads the photo and tolerates junk", () => {
    expect(parseParticipantMeta('{"photo":"https://x/y.jpg"}')).toEqual({ photo: "https://x/y.jpg" });
    expect(parseParticipantMeta('{"photo":null}')).toEqual({ photo: null });
    expect(parseParticipantMeta("not json")).toEqual({ photo: null });
    expect(parseParticipantMeta(undefined)).toEqual({ photo: null });
  });
});

describe("gridShape", () => {
  it("adapts to count and orientation", () => {
    expect(gridShape(1, true)).toEqual({ cols: 1, rows: 1 });
    expect(gridShape(2, true)).toEqual({ cols: 1, rows: 2 });
    expect(gridShape(2, false)).toEqual({ cols: 2, rows: 1 });
    expect(gridShape(3, true)).toEqual({ cols: 2, rows: 2 });
    expect(gridShape(3, false)).toEqual({ cols: 3, rows: 1 });
    expect(gridShape(4, false)).toEqual({ cols: 2, rows: 2 });
    expect(gridShape(6, true)).toEqual({ cols: 2, rows: 3 });
    expect(gridShape(6, false)).toEqual({ cols: 3, rows: 2 });
    expect(gridShape(9, true)).toEqual({ cols: 2, rows: null });
    expect(gridShape(12, false, true)).toEqual({ cols: 4, rows: null });
  });
});

describe("pickLayout", () => {
  const base = { tileKeys: ["a:camera", "b:camera"], participantCount: 2, screenShareKey: null, focusKey: null, anyCameraOn: false, preferGrid: false };

  it("waits while alone", () => {
    expect(pickLayout({ ...base, tileKeys: ["a:camera"], participantCount: 1 }).layout).toBe("waiting");
  });
  it("shows avatars in a grid when nobody has video", () => {
    expect(pickLayout(base)).toEqual({ layout: "grid", focusKey: null });
  });
  it("uses the 1:1 picture-in-picture view once a camera is on", () => {
    expect(pickLayout({ ...base, anyCameraOn: true }).layout).toBe("duo");
    expect(pickLayout({ ...base, anyCameraOn: true, preferGrid: true }).layout).toBe("grid");
  });
  it("spotlights a focused tile, falling back when it leaves", () => {
    expect(pickLayout({ ...base, focusKey: "b:camera" })).toEqual({ layout: "spotlight", focusKey: "b:camera" });
    expect(pickLayout({ ...base, focusKey: "gone:camera" }).layout).toBe("grid");
  });
  it("auto-spotlights a screen share", () => {
    const tileKeys = ["b:screen", ...base.tileKeys];
    expect(pickLayout({ ...base, tileKeys, screenShareKey: "b:screen" })).toEqual({ layout: "spotlight", focusKey: "b:screen" });
  });
});

describe("nearestCorner", () => {
  it("maps to logical corners, mirrored in RTL", () => {
    expect(nearestCorner(10, 10, 100, 100)).toBe("top-start");
    expect(nearestCorner(90, 90, 100, 100)).toBe("bottom-end");
    expect(nearestCorner(10, 90, 100, 100, true)).toBe("bottom-end");
  });
});

describe("deviceLabel", () => {
  it("cleans labels and falls back when unnamed", () => {
    expect(deviceLabel({ label: "FaceTime HD Camera (1C1C:B782)", deviceId: "x" }, "videoinput", 0)).toBe("FaceTime HD Camera");
    expect(deviceLabel({ label: "", deviceId: "default" }, "audioinput", 0)).toBe("System default");
    expect(deviceLabel({ label: "", deviceId: "abc" }, "audioinput", 1)).toBe("Microphone 2");
  });
});

describe("video stats", () => {
  const report = (bytes: number, ts: number) => [
    { type: "outbound-rtp", kind: "video", frameWidth: 320, frameHeight: 180, framesPerSecond: 30, bytesSent: 1000, timestamp: ts, codecId: "c1" },
    { type: "outbound-rtp", kind: "video", frameWidth: 1280, frameHeight: 720, framesPerSecond: 29.6, bytesSent: bytes, timestamp: ts, codecId: "c1" },
    { type: "codec", id: "c1", mimeType: "video/VP8" },
    { type: "outbound-rtp", kind: "audio", bytesSent: 999999, timestamp: ts },
  ];
  it("picks the top layer and computes bitrate", () => {
    const a = readVideoStats(report(100_000, 1000), "outbound")!;
    const b = readVideoStats(report(275_000, 2000), "outbound")!;
    expect(a).toMatchObject({ width: 1280, height: 720, fps: 30, codec: "VP8" });
    expect(formatVideoStats(b, a)).toBe("1280×720 · 30 fps · 1.4 Mbps · VP8");
    expect(formatVideoStats(a, null)).toBe("1280×720 · 30 fps · VP8");
  });
  it("returns null without video", () => {
    expect(readVideoStats([{ type: "inbound-rtp", kind: "audio" }], "inbound")).toBeNull();
  });
});

describe("camera quality", () => {
  it("bitrates scale with resolution", () => {
    expect(bitrateForHeight(720)).toBe(1_700_000);
    expect(bitrateForHeight(1080)).toBeGreaterThan(3_000_000);
    expect(bitrateForHeight(360)).toBeLessThan(600_000);
    expect(levelNeed(720)).toBeGreaterThan(levelNeed(480));
  });
  it("plans layers from the capture size", () => {
    expect(layerPlan(720, 480, 3).map((l) => l.scaleResolutionDownBy)).toEqual([1.5, 3, 6]);
    expect(layerPlan(1080, 1080, 3)[0]).toEqual({ scaleResolutionDownBy: 1, maxBitrate: bitrateForHeight(1080) });
    // A 480p camera can't be asked for 720p: top layer stays at capture size.
    expect(layerPlan(480, 720, 2)[0].scaleResolutionDownBy).toBe(1);
  });
  it("guesses a start level from the network", () => {
    expect(startLevel(null)).toBe(720);
    expect(startLevel({ effectiveType: "3g" })).toBe(480);
    expect(startLevel({ effectiveType: "4g", downlink: 0.6 })).toBe(480);
    expect(startLevel({ effectiveType: "4g", downlink: 2.5 })).toBe(720);
    expect(startLevel({ effectiveType: "4g", downlink: 10 })).toBe(720);
    expect(startLevel({ saveData: true })).toBe(360);
  });
  it("reads sender health", () => {
    const h = readSendHealth([
      { type: "outbound-rtp", kind: "video", active: true, qualityLimitationReason: "bandwidth" },
      { type: "outbound-rtp", kind: "video", active: false, qualityLimitationReason: "cpu" },
      { type: "remote-inbound-rtp", kind: "video", fractionLost: 0.1, roundTripTime: 0.2 },
      { type: "candidate-pair", nominated: true, state: "succeeded", availableOutgoingBitrate: 900_000 },
    ]);
    expect(h).toEqual({ availableBps: 900_000, loss: 0.1, rttMs: 200, limitation: "bandwidth", poor: false });
  });

  const ok: SendHealth = { availableBps: 5_000_000, loss: 0, rttMs: 50, limitation: "none", poor: false };
  const limited: SendHealth = { availableBps: 1_600_000, loss: 0.01, rttMs: 80, limitation: "bandwidth", poor: false };
  const run = (s: AutoState, h: SendHealth, from: number, to: number, max: 1080 | 720 = 1080) => {
    for (let t = from; t <= to; t += 2000) s = autoStep(s, h, t, max);
    return s;
  };

  it("waits out the ramp-up, then steps down to what the uplink carries", () => {
    let s = initialAutoState(720, 0);
    // "Bandwidth-limited" while the estimate ramps up isn't a slow network…
    s = run(s, limited, 0, AUTO_TIMING.ramp - 1);
    expect(s.level).toBe(720);
    // …but lost packets are, ramp or not.
    expect(run(initialAutoState(720, 0), { ...limited, loss: 0.2 }, 0, AUTO_TIMING.grace + 6000).level).toBeLessThan(720);
    s = run(s, limited, AUTO_TIMING.ramp, AUTO_TIMING.ramp + 6000);
    expect(s.level).toBe(480); // all of 480p's layers (~1.3 Mbps) fit in 85% of 1.6 Mbps
    expect(run(initialAutoState(720, 0), { ...limited, availableBps: 900_000 }, 0, AUTO_TIMING.ramp + 6000).level).toBe(360);
    expect(s.blockedUntil[720]).toBeGreaterThan(AUTO_TIMING.ramp);
  });
  it("doesn't flap on a short blip", () => {
    let s = initialAutoState(720, 0);
    s = run(s, ok, 0, 10_000);
    s = run(s, limited, 12_000, 14_000); // 2 s of trouble
    s = run(s, ok, 16_000, 18_000);
    expect(s.level).toBe(720);
  });
  it("steps up after sustained headroom, and backs off after a failed upgrade", () => {
    let s = initialAutoState(480, 0);
    s = run(s, ok, 0, 30_000);
    expect(s.level).toBe(720);
    s = run(s, ok, 32_000, 62_000);
    expect(s.level).toBe(1080);
    s = run(s, { ...limited, availableBps: null }, 64_000, 80_000);
    expect(s.level).toBe(720);
    const blocked = s.blockedUntil[1080]!;
    s = run(s, ok, 82_000, blocked - 1000);
    expect(s.level).toBe(720);
    expect(s.backoff[1080]).toBeGreaterThanOrEqual(AUTO_TIMING.backoff);
  });
  it("respects the ceiling", () => {
    let s = initialAutoState(720, 0);
    s = run(s, ok, 0, 120_000, 720);
    expect(s.level).toBe(720);
  });
  it("caps incoming video on a weak connection with hysteresis", () => {
    let c = { cap: "none" as const, badSince: null, goodSince: null } as Parameters<typeof recvCapStep>[0];
    c = recvCapStep(c, "poor", 0);
    c = recvCapStep(c, "poor", 3000);
    expect(c.cap).toBe("none");
    c = recvCapStep(c, "poor", 4000);
    expect(c.cap).toBe("medium");
    c = recvCapStep(c, "lost", 5000);
    c = recvCapStep(c, "lost", 9000);
    expect(c.cap).toBe("low");
    c = recvCapStep(c, "good", 10_000);
    c = recvCapStep(c, "good", 20_000);
    expect(c.cap).toBe("low");
    c = recvCapStep(c, "excellent", 25_000);
    expect(c.cap).toBe("none");
  });
});
