import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Room } from "livekit-client";
import { useCallAudioRoute } from "./call-audio-route";

// A phone running Chrome on Android, with the communication routes Chrome
// lists as microphones once mic permission is granted.
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
let devices: { kind: string; deviceId: string; label: string }[];
const listeners = new Set<() => void>();

function fakeRoom() {
  let active = "default";
  const handlers = new Map<string, Set<() => void>>();
  // The microphone track: it reports the input it is capturing from, as the browser does.
  const mic = { isMuted: false, mediaStreamTrack: { getSettings: () => ({ deviceId: active }) } };
  const room = {
    remoteParticipants: new Map(),
    localParticipant: { getTrackPublication: () => ({ track: mic }) },
    getActiveDevice: vi.fn(() => active),
    switchActiveDevice: vi.fn(async (_kind: string, id: string) => {
      active = id;
      return true;
    }),
    on: (ev: string, h: () => void) => (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(h) && room,
    off: (ev: string, h: () => void) => (handlers.get(ev)?.delete(h), room),
    fire: (ev: string) => handlers.get(ev)?.forEach((h) => h()),
  };
  return room;
}

beforeEach(() => {
  localStorage.clear();
  devices = [
    { kind: "audioinput", deviceId: "default", label: "Default" },
    { kind: "audioinput", deviceId: "spk", label: "Speakerphone" },
    { kind: "audioinput", deviceId: "ear", label: "Headset earpiece" },
    { kind: "audiooutput", deviceId: "default", label: "Default" },
  ];
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID_UA);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => devices,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    },
  });
});
afterEach(() => vi.restoreAllMocks());

describe("useCallAudioRoute on Chrome for Android", () => {
  it("routes by switching the mic input: earpiece by default, Speakerphone on toggle, remembered", async () => {
    const room = fakeRoom();
    const { result } = renderHook(() => useCallAudioRoute(room as unknown as Room, false));
    await waitFor(() => expect(result.current.strategy).toBe("input"));
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audioinput", "ear"));
    expect(result.current.route).toBe("earpiece");

    act(() => result.current.toggle());
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audioinput", "spk"));
    expect(result.current.route).toBe("speaker");
    expect(JSON.parse(localStorage.getItem("chat:call-audio-route")!)).toEqual({ voice: "speaker" });
    expect(result.current.diagnostics.inputs).toContain("Speakerphone");
    await waitFor(() => expect(result.current.diagnostics.lastAction).toBe("Switched mic to Speakerphone: ok"));
    expect(result.current.diagnostics.activeInput).toBe("Speakerphone");
  });

  it("re-applies the route after a reconnect", async () => {
    const room = fakeRoom();
    const { result } = renderHook(() => useCallAudioRoute(room as unknown as Room, false));
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenCalledWith("audioinput", "ear"));
    const n = room.switchActiveDevice.mock.calls.length;
    act(() => room.fire("reconnected"));
    await waitFor(() => expect(room.switchActiveDevice.mock.calls.length).toBeGreaterThan(n));
    expect(result.current.route).toBe("earpiece");
  });

  it("a Bluetooth headset plugged in mid-call wins over the speaker default of a video call", async () => {
    const room = fakeRoom();
    const { result } = renderHook(() => useCallAudioRoute(room as unknown as Room, true));
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audioinput", "spk"));
    devices = [...devices, { kind: "audioinput", deviceId: "bt", label: "Bluetooth headset" }];
    act(() => listeners.forEach((l) => l()));
    await waitFor(() => expect(room.switchActiveDevice).toHaveBeenLastCalledWith("audioinput", "bt"));
    expect(result.current.headset).toBe("Bluetooth headset");
  });
});

describe("useCallAudioRoute reports what the route change did", () => {
  it("says so when the browser keeps the microphone on the previous input", async () => {
    const room = fakeRoom();
    // The switch "succeeds" but the track keeps reporting the default input.
    room.switchActiveDevice.mockImplementation(async () => true);
    const { result } = renderHook(() => useCallAudioRoute(room as unknown as Room, false));
    await waitFor(() => expect(result.current.diagnostics.lastAction).toMatch(/Switched mic to Headset earpiece: failed/));
    expect(result.current.diagnostics.lastError).toMatch(/still on/);
  });

  it("reports the exception message when the switch throws", async () => {
    const room = fakeRoom();
    room.switchActiveDevice.mockImplementation(async () => {
      throw new Error("OverconstrainedError: device gone");
    });
    const { result } = renderHook(() => useCallAudioRoute(room as unknown as Room, false));
    await waitFor(() => expect(result.current.diagnostics.lastError).toBe("OverconstrainedError: device gone"));
    expect(result.current.diagnostics.lastAction).toBe("Switched mic to Headset earpiece: failed");
  });

  it("says the change waits for unmute while the microphone is muted", async () => {
    const room = fakeRoom();
    const { result } = renderHook(() => useCallAudioRoute(room as unknown as Room, false));
    await waitFor(() => expect(result.current.diagnostics.lastAction).toBe("Switched mic to Headset earpiece: ok"));
    // Muted: the route change is only queued by LiveKit.
    (room.localParticipant.getTrackPublication() as unknown as { track: { isMuted: boolean } }).track.isMuted = true;
    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.diagnostics.lastAction).toBe("Switched mic to Speakerphone: waiting until the microphone is unmuted"));
  });
});
