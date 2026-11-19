import { describe, expect, it } from "vitest";
import { classifyInputRoutes, classifyOutputs, defaultRoute, detectPlatform, deviceForRoute, pickStrategy } from "./call-audio-route";

const inp = (deviceId: string, label: string) => ({ kind: "audioinput" as MediaDeviceKind, deviceId, label });
const out = (deviceId: string, label: string) => ({ kind: "audiooutput" as MediaDeviceKind, deviceId, label });

// What Chrome on Android lists after mic permission (ids are opaque hashes).
const PIXEL = [inp("default", "Default"), inp("a1f3", "Speakerphone"), inp("b7c2", "Headset earpiece"), out("default", "Default")];
const PIXEL_BT = [...PIXEL, inp("c9d0", "Bluetooth headset")];
const PIXEL_WIRED = [...PIXEL, inp("e4e4", "Wired headset")];

describe("detectPlatform", () => {
  it("tells iPhone/iPad (incl. iPadOS desktop UA), Android and desktop apart", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)")).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130")).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe("desktop");
  });
});

describe("Android communication routes (exposed as microphones)", () => {
  it("'Headset earpiece' is the earpiece, not a headset; Speakerphone is the speaker", () => {
    expect(classifyInputRoutes(PIXEL)).toEqual({ speaker: "a1f3", earpiece: "b7c2" });
  });
  it("detects Bluetooth and wired headsets", () => {
    expect(classifyInputRoutes(PIXEL_BT).headset).toEqual({ id: "c9d0", label: "Bluetooth headset" });
    expect(classifyInputRoutes(PIXEL_WIRED).headset).toEqual({ id: "e4e4", label: "Wired headset" });
  });
  it("matches a few localized labels", () => {
    expect(classifyInputRoutes([inp("1", "بلندگو"), inp("2", "گوشی")])).toEqual({ speaker: "1", earpiece: "2" });
    expect(classifyInputRoutes([inp("1", "Lautsprecher"), inp("2", "Hörmuschel")])).toEqual({ speaker: "1", earpiece: "2" });
  });
  it("ignores unlabeled (no permission yet) and default/communications aliases", () => {
    expect(classifyInputRoutes([inp("default", "Default - Speakerphone"), inp("x", "")])).toEqual({});
  });
  it("selects the right input per route; a headset replaces the earpiece", () => {
    const r = classifyInputRoutes(PIXEL);
    expect(deviceForRoute("speaker", r)).toBe("a1f3");
    expect(deviceForRoute("earpiece", r)).toBe("b7c2");
    expect(deviceForRoute("earpiece", classifyInputRoutes(PIXEL_BT))).toBe("c9d0");
  });
});

describe("pickStrategy", () => {
  it("Android with Chrome's route inputs → switch the mic input (the mechanism that actually moves the sound)", () => {
    expect(pickStrategy("android", false, classifyInputRoutes(PIXEL), classifyOutputs(PIXEL))).toBe("input");
    expect(pickStrategy("android", true, classifyInputRoutes(PIXEL), classifyOutputs(PIXEL))).toBe("input");
  });
  it("real separate outputs → setSinkId", () => {
    const devs = [out("e", "Earpiece"), out("s", "Speaker")];
    expect(pickStrategy("desktop", true, classifyInputRoutes(devs), classifyOutputs(devs))).toBe("sink");
  });
  it("Android with nothing usable → Web Audio last resort; iPhone honest; desktop picker", () => {
    expect(pickStrategy("android", false, {}, {})).toBe("webaudio");
    expect(pickStrategy("ios", true, {}, {})).toBe("unsupported");
    expect(pickStrategy("desktop", true, {}, {})).toBe("none");
  });
});

describe("defaultRoute", () => {
  it("earpiece for voice, speaker once video is on (Telegram)", () => {
    expect(defaultRoute(false, {}, false)).toBe("earpiece");
    expect(defaultRoute(true, {}, false)).toBe("speaker");
  });
  it("remembers this device's choice per kind of call", () => {
    expect(defaultRoute(false, { voice: "speaker" }, false)).toBe("speaker");
    expect(defaultRoute(true, { video: "earpiece" }, false)).toBe("earpiece");
  });
  it("a connected headset wins over the speaker default", () => {
    expect(defaultRoute(true, { video: "speaker" }, true)).toBe("earpiece");
  });
});
