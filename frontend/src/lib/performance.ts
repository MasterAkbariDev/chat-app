/** Per-device motion & performance preferences (not synced to the account:
 * a fast laptop and an old phone of the same person want different things). */

export type MotionPref = "system" | "reduce" | "full";
/** How animated emoji/stickers play: automatically, only while hovered or
 * focused, or never (first frame only). */
export type AnimatedMediaPref = "auto" | "interact" | "off";

export interface PerformancePrefs {
  /** One switch for older devices: reduces motion, stops animated media and
   *  drops expensive effects (wallpaper blur). Overrides the two below. */
  lite: boolean;
  motion: MotionPref;
  animatedMedia: AnimatedMediaPref;
  /** Videos up to 20 s restart by themselves when they end in the viewer. */
  replayShort: boolean;
}

export const DEFAULT_PERFORMANCE: PerformancePrefs = { lite: false, motion: "system", animatedMedia: "auto", replayShort: true };
export const PERFORMANCE_STORAGE_KEY = "chat:performance";

export function readPerformancePrefs(): PerformancePrefs {
  if (typeof window === "undefined") return DEFAULT_PERFORMANCE;
  try {
    const raw = JSON.parse(window.localStorage.getItem(PERFORMANCE_STORAGE_KEY) ?? "null") as Partial<PerformancePrefs> | null;
    return {
      lite: raw?.lite === true,
      motion: raw?.motion === "reduce" || raw?.motion === "full" ? raw.motion : "system",
      animatedMedia: raw?.animatedMedia === "interact" || raw?.animatedMedia === "off" ? raw.animatedMedia : "auto",
      replayShort: raw?.replayShort !== false,
    };
  } catch {
    return DEFAULT_PERFORMANCE;
  }
}

/** Reduced motion actually in effect. */
export function effectiveReduceMotion(p: PerformancePrefs, osReduces: boolean): boolean {
  return p.lite || p.motion === "reduce" || (p.motion === "system" && osReduces);
}

/** Animated-media behaviour actually in effect: lite turns it off; an OS
 *  "reduce motion" request downgrades autoplay to play-on-interaction. */
export function effectiveAnimatedMedia(p: PerformancePrefs, osReduces: boolean): AnimatedMediaPref {
  if (p.lite) return "off";
  if (p.animatedMedia === "auto" && effectiveReduceMotion(p, osReduces)) return "interact";
  return p.animatedMedia;
}

/** Whether smooth (animated) scrolling should be used right now. */
export function smoothScroll(): ScrollBehavior {
  return typeof document !== "undefined" && document.documentElement.dataset.motion === "reduce" ? "auto" : "smooth";
}

/** Inline <head> script: applies `data-motion` / `data-lite` before first
 *  paint so nothing animates for a frame before React hydrates. Must mirror
 *  the logic above. */
export const PERFORMANCE_BOOTSTRAP_SCRIPT = `(function(){try{var d=document.documentElement,p=JSON.parse(localStorage.getItem(${JSON.stringify(
  PERFORMANCE_STORAGE_KEY,
)})||"null")||{};var os=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;var r=p.lite===true||p.motion==="reduce"||((p.motion!=="full")&&os);d.setAttribute("data-motion",r?"reduce":"full");if(p.lite===true)d.setAttribute("data-lite","");}catch(e){}})();`;
