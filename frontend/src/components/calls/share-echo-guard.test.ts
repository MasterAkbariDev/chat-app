import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ECHO_DUCK_GAIN, ShareEchoGuard } from "./share-echo-guard";

// Web Audio and MediaStream are not in jsdom: a graph that records what it was asked to do.
function installAudioGraph() {
  const gain = { value: 1, setTargetAtTime: vi.fn() };
  const outTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
  const ctx = {
    currentTime: 0,
    gain,
    close: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    createGain: vi.fn(() => ({ gain, connect: vi.fn(), disconnect: vi.fn() })),
    createMediaStreamDestination: vi.fn(() => ({ stream: { getAudioTracks: () => [outTrack] } })),
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
  };
  const Ctor = vi.fn(() => ctx);
  vi.stubGlobal("AudioContext", Ctor);
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(public tracks: unknown[] = []) {}
      getAudioTracks() {
        return this.tracks;
      }
    },
  );
  return { ctx, gain, outTrack, Ctor };
}

describe("ShareEchoGuard", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.unstubAllGlobals());

  it("publishes a processed track that goes through a gain", async () => {
    const { ctx, outTrack } = installAudioGraph();
    const guard = new ShareEchoGuard();
    await guard.init({ kind: "audio", track: {} as MediaStreamTrack } as never);
    expect(guard.processedTrack).toBe(outTrack);
    expect(ctx.createGain).toHaveBeenCalledTimes(1);
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(1);
  });

  it("ducks the shared sound to the duck gain and releases it back to unity", async () => {
    const { gain } = installAudioGraph();
    const guard = new ShareEchoGuard();
    await guard.init({ kind: "audio", track: {} as MediaStreamTrack } as never);
    guard.setDucked(true);
    expect(gain.setTargetAtTime).toHaveBeenLastCalledWith(ECHO_DUCK_GAIN, 0, 0.02);
    guard.setDucked(false);
    expect(gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.2);
  });

  it("starts ducked if remote speech was already going when it was attached", async () => {
    const { ctx, gain } = installAudioGraph();
    const guard = new ShareEchoGuard();
    guard.setDucked(true);
    await guard.init({ kind: "audio", track: {} as MediaStreamTrack } as never);
    expect(ctx.createGain).toHaveBeenCalled();
    expect(gain.value).toBe(ECHO_DUCK_GAIN);
  });

  it("closes its own context on destroy and never touches the speakers", async () => {
    const { ctx } = installAudioGraph();
    const guard = new ShareEchoGuard();
    await guard.init({ kind: "audio", track: {} as MediaStreamTrack } as never);
    await guard.destroy();
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(guard.processedTrack).toBeUndefined();
  });
});
