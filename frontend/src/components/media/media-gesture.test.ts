import { describe, expect, it } from "vitest";
import {
  DOUBLE_TAP_MS,
  HOLD_DELAY_MS,
  dragPastEdge,
  dragStep,
  holdLabel,
  holdSpeed,
  isDoubleTap,
  isTapDuration,
  movedBeyond,
  pageDirForZone,
  rewindTime,
  seekDelta,
  seekLabel,
  settleOffset,
  shouldReplayShort,
  slideOffsetPct,
  swipeStep,
  trackDragOffset,
  zoneAt,
} from "./media-gesture";

describe("zoneAt", () => {
  it("splits the stage into thirds: left, centre, right", () => {
    expect(zoneAt(0, 0, 300)).toBe("left");
    expect(zoneAt(99, 0, 300)).toBe("left");
    expect(zoneAt(100, 0, 300)).toBe("center");
    expect(zoneAt(150, 0, 300)).toBe("center");
    expect(zoneAt(200, 0, 300)).toBe("center");
    expect(zoneAt(201, 0, 300)).toBe("right");
    expect(zoneAt(300, 0, 300)).toBe("right");
  });

  it("measures from the element's left edge, not the viewport", () => {
    expect(zoneAt(410, 400, 300)).toBe("left");
    expect(zoneAt(690, 400, 300)).toBe("right");
  });

  it("falls back to centre for an unmeasured box", () => {
    expect(zoneAt(10, 0, 0)).toBe("center");
  });
});

describe("pageDirForZone", () => {
  it("pages back on the left and forward on the right in LTR", () => {
    expect(pageDirForZone("left", false)).toBe(-1);
    expect(pageDirForZone("right", false)).toBe(1);
  });

  it("flips in RTL so the start edge (right) goes back, like the chevrons", () => {
    expect(pageDirForZone("right", true)).toBe(-1);
    expect(pageDirForZone("left", true)).toBe(1);
  });
});

describe("isDoubleTap", () => {
  it("is a double tap on the same side within the window", () => {
    expect(isDoubleTap({ zone: "right", time: 1000 }, "right", 1000 + DOUBLE_TAP_MS - 1)).toBe(true);
  });

  it("is not a double tap after the window, on the other side, or in the centre", () => {
    expect(isDoubleTap({ zone: "right", time: 1000 }, "right", 1000 + DOUBLE_TAP_MS)).toBe(false);
    expect(isDoubleTap({ zone: "right", time: 1000 }, "left", 1100)).toBe(false);
    expect(isDoubleTap({ zone: "center", time: 1000 }, "center", 1100)).toBe(false);
    expect(isDoubleTap(null, "right", 1100)).toBe(false);
  });
});

describe("hold and seek helpers", () => {
  it("right hold plays at 2×; left hold rewinds at 4×", () => {
    expect(holdLabel("right")).toBe("2×");
    expect(holdLabel("left")).toBe("« 4×");
  });

  it("rewinds 4 seconds per second held, never below zero", () => {
    expect(rewindTime(20, 1000)).toBe(16);
    expect(rewindTime(20, 500)).toBe(18);
    expect(rewindTime(3, 2000)).toBe(0);
    expect(rewindTime(10, -50)).toBe(10);
  });

  it("double tap seeks 10 s forward on the right and back on the left", () => {
    expect(seekDelta("right")).toBe(10);
    expect(seekDelta("left")).toBe(-10);
    expect(seekLabel("right")).toBe("+10 s");
    expect(seekLabel("left")).toBe("−10 s");
  });
});

describe("press classification", () => {
  it("a press shorter than the hold delay is a tap", () => {
    expect(isTapDuration(HOLD_DELAY_MS - 1)).toBe(true);
    expect(isTapDuration(HOLD_DELAY_MS)).toBe(false);
  });

  it("a drag past the slop is not a tap", () => {
    expect(movedBeyond(3, 4)).toBe(false);
    expect(movedBeyond(6, 8)).toBe(true);
  });
});

describe("shouldReplayShort", () => {
  it("replays clips of 20 s or less when the setting is on", () => {
    expect(shouldReplayShort(5, true)).toBe(true);
    expect(shouldReplayShort(20, true)).toBe(true);
    expect(shouldReplayShort(0.5, true)).toBe(true);
  });
  it("stops longer clips at the end", () => {
    expect(shouldReplayShort(20.1, true)).toBe(false);
    expect(shouldReplayShort(120, true)).toBe(false);
  });
  it("respects the setting being off", () => {
    expect(shouldReplayShort(5, false)).toBe(false);
  });
  it("does nothing when the length is unknown", () => {
    expect(shouldReplayShort(null, true)).toBe(false);
    expect(shouldReplayShort(undefined, true)).toBe(false);
    expect(shouldReplayShort(0, true)).toBe(false);
    expect(shouldReplayShort(Number.NaN, true)).toBe(false);
  });
});

describe("swipe maths", () => {
  const base = { width: 400, rtl: false, canPrev: true, canNext: true };

  it("turns the page past a quarter of the width", () => {
    expect(swipeStep({ ...base, dx: -100, vx: 0 })).toBe(1);
    expect(swipeStep({ ...base, dx: 100, vx: 0 })).toBe(-1);
  });

  it("springs back before the threshold", () => {
    expect(swipeStep({ ...base, dx: -99, vx: 0 })).toBe(0);
    expect(swipeStep({ ...base, dx: 0, vx: 2 })).toBe(0);
  });

  it("turns the page on a fast flick in its own direction, however short", () => {
    expect(swipeStep({ ...base, dx: -30, vx: -0.9 })).toBe(1);
    expect(swipeStep({ ...base, dx: 30, vx: 0.9 })).toBe(-1);
  });

  it("ignores a flick against its own direction or a tiny one", () => {
    expect(swipeStep({ ...base, dx: -30, vx: 0.9 })).toBe(0);
    expect(swipeStep({ ...base, dx: -8, vx: -2 })).toBe(0);
  });

  it("never turns past the first or last item", () => {
    expect(swipeStep({ ...base, dx: -300, vx: 0, canNext: false })).toBe(0);
    expect(swipeStep({ ...base, dx: 300, vx: 0, canPrev: false })).toBe(0);
  });

  it("mirrors direction in RTL: a leftward swipe goes back", () => {
    expect(dragStep(-10, false)).toBe(1);
    expect(dragStep(-10, true)).toBe(-1);
    expect(swipeStep({ ...base, rtl: true, dx: -200, vx: 0 })).toBe(-1);
    expect(swipeStep({ ...base, rtl: true, dx: 200, vx: 0 })).toBe(1);
  });

  it("rubber-bands only past an end", () => {
    expect(dragPastEdge(-10, 0, 3, false)).toBe(false);
    expect(dragPastEdge(10, 0, 3, false)).toBe(true);
    expect(dragPastEdge(-10, 2, 3, false)).toBe(true);
    expect(trackDragOffset(-30, 0, 3, false)).toBe(-30);
    expect(trackDragOffset(30, 0, 3, false)).toBe(10);
  });

  it("places neighbours and settles the track in the right place for LTR and RTL", () => {
    expect(slideOffsetPct(1, false)).toBe(100);
    expect(slideOffsetPct(-1, false)).toBe(-100);
    expect(slideOffsetPct(1, true)).toBe(-100);
    // Settling onto the next item moves the track one width back (LTR), forward (RTL).
    expect(settleOffset(1, 400, false)).toBe(-400);
    expect(settleOffset(-1, 400, false)).toBe(400);
    expect(settleOffset(1, 400, true)).toBe(400);
    expect(settleOffset(-1, 400, true)).toBe(-400);
  });
});

describe("holdSpeed", () => {
  it("starts at the base speed for a short slide and steps up with travel", () => {
    expect(holdSpeed("right", 0)).toBe(2);
    expect(holdSpeed("right", 30)).toBe(2);
    expect(holdSpeed("right", 60)).toBe(2.5);
    expect(holdSpeed("right", -60)).toBe(2.5);
    expect(holdSpeed("right", 400)).toBe(4);
  });

  it("doubles the rewind speed per step, capped at 16×", () => {
    expect(holdSpeed("left", 0)).toBe(4);
    expect(holdSpeed("left", 60)).toBe(8);
    expect(holdSpeed("left", 100)).toBe(16);
    expect(holdSpeed("left", 900)).toBe(16);
  });
});
