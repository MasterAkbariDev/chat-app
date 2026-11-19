import { afterEach, describe, expect, it, vi } from "vitest";
import { isNearJump, settleOnTarget, targetDelta } from "@/lib/jump-scroll";

describe("targetDelta", () => {
  const container = { top: 100, height: 600 };
  it("start puts the target's top at the container's top", () => {
    expect(targetDelta(container, { top: 400, height: 50 }, "start")).toBe(300);
  });
  it("center centres the target (tall targets align to the top)", () => {
    expect(targetDelta(container, { top: 400, height: 100 }, "center")).toBe(400 - 100 - 250);
    expect(targetDelta(container, { top: 400, height: 900 }, "center")).toBe(300);
  });
});

describe("isNearJump", () => {
  it("is near within 1.5 viewports", () => {
    expect(isNearJump(800, 600)).toBe(true);
    expect(isNearJump(-901, 600)).toBe(false);
  });
});

describe("settleOnTarget", () => {
  afterEach(() => vi.useRealTimers());

  /** A fake container whose target shifts as rows "measure in" for a few frames. */
  function setup(shifts: number[], maxScroll = 10_000) {
    let scrollTop = 0;
    let targetDocTop = 5000;
    let mounted = false;
    const container = {
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(v: number) {
        scrollTop = Math.max(0, Math.min(maxScroll, v));
      },
      getBoundingClientRect: () => ({ top: 0, height: 600 }),
    } as unknown as HTMLElement;
    const target = {
      getBoundingClientRect: () => ({ top: targetDocTop - scrollTop, height: 40 }),
    } as unknown as HTMLElement;
    const scrollToIndex = vi.fn(() => {
      scrollTop = 4700; // the estimate: close, not exact
      mounted = true;
    });
    const getTarget = () => {
      const s = shifts.shift();
      if (s) targetDocTop += s;
      return mounted ? target : null;
    };
    return { container, getTarget, scrollToIndex, top: () => scrollTop, targetTop: () => targetDocTop };
  }

  it("corrects against measurement shifts, then settles exactly once", async () => {
    vi.useFakeTimers();
    const env = setup([120, -40, 0, 0]);
    const onSettled = vi.fn();
    settleOnTarget({ container: env.container, getTarget: env.getTarget, scrollToIndex: env.scrollToIndex, align: "start", onSettled });
    await vi.advanceTimersByTimeAsync(500);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(env.top()).toBe(env.targetTop());
  });

  it("settles when clamped at the bottom edge", async () => {
    vi.useFakeTimers();
    const env = setup([], 4800);
    const onSettled = vi.fn();
    settleOnTarget({ container: env.container, getTarget: env.getTarget, scrollToIndex: env.scrollToIndex, align: "start", onSettled });
    await vi.advanceTimersByTimeAsync(200);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(env.top()).toBe(4800);
  });

  it("can be cancelled", async () => {
    vi.useFakeTimers();
    const env = setup([]);
    const onSettled = vi.fn();
    const cancel = settleOnTarget({ container: env.container, getTarget: env.getTarget, scrollToIndex: env.scrollToIndex, align: "start", onSettled });
    cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(onSettled).not.toHaveBeenCalled();
  });
});
