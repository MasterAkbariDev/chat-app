/** Pure helpers for Telegram-style tap and hold gestures on the media viewer: the outer thirds
 *  of the screen are the "side" zones (hold → 2× or fast rewind, tap → page, double tap → ±10 s
 *  on a video). Kept free of DOM so they can be unit-tested. */

export type SideZone = "left" | "right";
export type TapZone = SideZone | "center";

/** A press this long on a side counts as a hold, not a tap. */
export const HOLD_DELAY_MS = 250;
/** Two taps on the same side this close together are a double tap (also the wait before a
 *  single side tap pages, so the second tap can still land). */
export const DOUBLE_TAP_MS = 300;
export const HOLD_RATE = 2;
export const REWIND_RATE = 4;
export const SEEK_STEP_SEC = 10;

/** A press shorter than a hold: only these can be taps (a long press on a side does nothing). */
export function isTapDuration(ms: number): boolean {
  return ms < HOLD_DELAY_MS;
}

/** Which third of the stage an x coordinate falls in. */
export function zoneAt(x: number, left: number, width: number): TapZone {
  if (!(width > 0)) return "center";
  const t = (x - left) / width;
  if (t < 1 / 3) return "left";
  if (t > 2 / 3) return "right";
  return "center";
}

/** Previous (-1) or next (+1) for a tap on a side. In RTL the start edge is on the right, so the
 *  right side goes back there, matching the Previous/Next chevrons and the swipe direction. */
export function pageDirForZone(zone: SideZone, rtl: boolean): -1 | 1 {
  const leftIsPrevious = !rtl;
  return (zone === "left") === leftIsPrevious ? -1 : 1;
}

/** True when `now` completes a double tap on `zone` after the previous tap `prev`. */
export function isDoubleTap(prev: { zone: TapZone; time: number } | null, zone: TapZone, now: number): boolean {
  return !!prev && zone !== "center" && prev.zone === zone && now - prev.time < DOUBLE_TAP_MS;
}

/** Media position after rewinding for `elapsedMs` at `rate`×, never below 0. */
export function rewindTime(current: number, elapsedMs: number, rate: number = REWIND_RATE): number {
  return Math.max(0, current - (Math.max(0, elapsedMs) / 1000) * rate);
}

/** Seconds a double tap on `zone` jumps: forward on the right, back on the left. */
export function seekDelta(zone: SideZone): number {
  return zone === "right" ? SEEK_STEP_SEC : -SEEK_STEP_SEC;
}

/** Sideways travel (px) from where a hold began per speed step. */
export const HOLD_STEP_PX = 40;

/** Speed a hold reaches after the finger has travelled `travelPx` sideways from where it began,
 *  as in Telegram: a hold starts at 2× and steps up 0.5× per step, to 4×; rewind starts at 4× and
 *  doubles per step, to 16×. Short travel keeps the base speed. */
export function holdSpeed(zone: SideZone, travelPx: number): number {
  const level = Math.max(0, Math.floor((Math.abs(travelPx) - HOLD_STEP_PX / 2) / HOLD_STEP_PX));
  return zone === "right" ? Math.min(4, HOLD_RATE + 0.5 * level) : Math.min(16, REWIND_RATE * 2 ** level);
}

/** Label on the side while a hold is active, at `rate` (the base speed by default). */
export function holdLabel(zone: SideZone, rate: number = zone === "right" ? HOLD_RATE : REWIND_RATE): string {
  return zone === "right" ? `${rate}×` : `« ${rate}×`;
}

/** Label flashed after a double-tap seek. */
export function seekLabel(zone: SideZone): string {
  return zone === "right" ? `+${SEEK_STEP_SEC} s` : `−${SEEK_STEP_SEC} s`;
}

/** Whether a pointer has travelled far enough to count as a drag rather than a tap. */
export function movedBeyond(dx: number, dy: number, slop = 10): boolean {
  return Math.hypot(dx, dy) >= slop;
}

/** Videos this long or shorter restart by themselves in the viewer. */
export const SHORT_CLIP_SEC = 20;

/** Whether a video in the viewer should loop: it is short enough and the setting is on. Longer
 *  videos (or an unknown length) stop at the end. */
export function shouldReplayShort(durationSec: number | null | undefined, enabled: boolean): boolean {
  return enabled && typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec > 0 && durationSec <= SHORT_CLIP_SEC;
}

/** Duration of the viewer's page transition; matches the other viewer transitions. */
export const PAGE_MS = 220;
/** A swipe past this fraction of the stage width turns the page. */
export const SWIPE_COMMIT_FRACTION = 0.25;
/** A swipe faster than this (px/ms), in its own direction, turns the page however short. */
export const SWIPE_FLICK_PX_PER_MS = 0.5;
/** A flick must still travel this far, so a tap never turns the page. */
export const SWIPE_FLICK_MIN_PX = 16;

/** Index step a horizontal drag heads for: +1 (next) or -1 (previous). Swiping left shows the
 *  next item in LTR; in RTL the sense is mirrored. */
export function dragStep(dx: number, rtl: boolean): -1 | 1 {
  return dx * (rtl ? -1 : 1) < 0 ? 1 : -1;
}

/** Whether a drag of `dx` would go past the first or last item (it then rubber-bands). */
export function dragPastEdge(dx: number, index: number, count: number, rtl: boolean): boolean {
  const target = index + dragStep(dx, rtl);
  return target < 0 || target > count - 1;
}

/** Offset applied to the track while dragging: the finger's travel, or a third of it past an edge. */
export function trackDragOffset(dx: number, index: number, count: number, rtl: boolean): number {
  return dragPastEdge(dx, index, count, rtl) ? dx / 3 : dx;
}

/** Index step to take when a horizontal swipe ends: +1 / -1 to turn the page, 0 to spring back.
 *  Turns past 25% of the width, or on a flick in its own direction. Never past the ends. */
export function swipeStep(opts: { dx: number; vx: number; width: number; rtl: boolean; canPrev: boolean; canNext: boolean }): -1 | 0 | 1 {
  const { dx, vx, width, rtl, canPrev, canNext } = opts;
  if (dx === 0 || !(width > 0)) return 0;
  const far = Math.abs(dx) >= width * SWIPE_COMMIT_FRACTION;
  const flick = Math.abs(vx) >= SWIPE_FLICK_PX_PER_MS && Math.sign(vx) === Math.sign(dx) && Math.abs(dx) >= SWIPE_FLICK_MIN_PX;
  if (!far && !flick) return 0;
  const step = dragStep(dx, rtl);
  if (step === 1 ? !canNext : !canPrev) return 0;
  return step;
}

/** Horizontal position, as a percentage of the stage width, of the slide `step` places away
 *  from the current one. */
export function slideOffsetPct(step: number, rtl: boolean): number {
  return step * (rtl ? -100 : 100);
}

/** Track translation (px) that brings the slide `step` away into the centre. */
export function settleOffset(step: number, width: number, rtl: boolean): number {
  return -slideOffsetPct(step, rtl) * width / 100;
}
