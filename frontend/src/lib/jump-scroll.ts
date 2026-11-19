/**
 * Placing the message feed on a jump target (pins, replies, search, dates, the player).
 *
 * The feed is virtualized with estimated row heights, so one `scrollToIndex` lands roughly
 * right and rows then measure in and shift the target. Rather than letting the reader watch
 * that (scroll → rows load → scroll again), `settleOnTarget` corrects frame by frame against
 * the real DOM position while the feed is hidden, and calls `onSettled` once the target has
 * stopped moving — the caller reveals the feed and flashes the message then.
 */

export type JumpAlign = "center" | "start";

/** How far (px) the container must scroll for the target to sit where `align` wants it. */
export function targetDelta(container: { top: number; height: number }, target: { top: number; height: number }, align: JumpAlign): number {
  if (align === "start") return target.top - container.top;
  return target.top - container.top - (container.height - Math.min(target.height, container.height)) / 2;
}

/** A jump within this many viewport heights of an already-mounted target is a short visible
 *  scroll; anything farther (or not mounted yet) is placed instantly. */
export const NEAR_JUMP_VIEWPORTS = 1.5;

export function isNearJump(delta: number, viewportHeight: number): boolean {
  return Math.abs(delta) <= viewportHeight * NEAR_JUMP_VIEWPORTS;
}

export function settleOnTarget(opts: {
  container: HTMLElement;
  /** The target's element, once mounted (null while the virtualizer hasn't rendered it). */
  getTarget: () => HTMLElement | null;
  /** Coarse positioning by index — used while the target isn't mounted. */
  scrollToIndex: () => void;
  align: JumpAlign;
  onSettled: () => void;
  /** Safety stop (frames). */
  maxFrames?: number;
}): () => void {
  const { container, getTarget, scrollToIndex, align, onSettled, maxFrames = 24 } = opts;
  let cancelled = false;
  let frame = 0;
  let stable = 0;
  let raf = 0;
  const step = () => {
    if (cancelled) return;
    frame += 1;
    const el = getTarget();
    if (!el) {
      stable = 0;
      scrollToIndex();
    } else {
      const delta = targetDelta(container.getBoundingClientRect(), el.getBoundingClientRect(), align);
      if (Math.abs(delta) <= 1) stable += 1;
      else {
        const before = container.scrollTop;
        container.scrollTop = before + delta;
        // Clamped at the top/bottom edge: it can't get any closer, so it's settled.
        stable = Math.abs(container.scrollTop - before) < 1 ? stable + 1 : 0;
      }
    }
    if (stable >= 2 || frame >= maxFrames) {
      onSettled();
      return;
    }
    raf = requestAnimationFrame(step);
  };
  scrollToIndex();
  raf = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
  };
}
