"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_PERFORMANCE,
  PERFORMANCE_STORAGE_KEY,
  effectiveAnimatedMedia,
  effectiveReduceMotion,
  readPerformancePrefs,
  type AnimatedMediaPref,
  type PerformancePrefs,
} from "@/lib/performance";

interface PerformanceContextValue {
  prefs: PerformancePrefs;
  setPrefs: (patch: Partial<PerformancePrefs>) => void;
  /** Effective values (prefs + OS setting + lite mode). */
  reduceMotion: boolean;
  animatedMedia: AnimatedMediaPref;
  lite: boolean;
}

const PerformanceContext = createContext<PerformanceContextValue>({
  prefs: DEFAULT_PERFORMANCE,
  setPrefs: () => {},
  reduceMotion: false,
  animatedMedia: "auto",
  lite: false,
});

export function PerformanceProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefsState] = useState<PerformancePrefs>(readPerformancePrefs);
  const [osReduces, setOsReduces] = useState(() =>
    typeof window !== "undefined" ? !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches : false,
  );

  // Follow the OS setting live (it can change while the app is open).
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setOsReduces(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const reduceMotion = effectiveReduceMotion(prefs, osReduces);
  const animatedMedia = effectiveAnimatedMedia(prefs, osReduces);

  // Reflect onto <html> for CSS (the inline bootstrap script did this before
  // first paint; this keeps it in sync with later changes).
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.motion = reduceMotion ? "reduce" : "full";
    if (prefs.lite) root.setAttribute("data-lite", "");
    else root.removeAttribute("data-lite");
  }, [reduceMotion, prefs.lite]);

  const setPrefs = useCallback((patch: Partial<PerformancePrefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable (private mode) — still applies for this session.
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ prefs, setPrefs, reduceMotion, animatedMedia, lite: prefs.lite }),
    [prefs, setPrefs, reduceMotion, animatedMedia],
  );
  return <PerformanceContext.Provider value={value}>{children}</PerformanceContext.Provider>;
}

export function usePerformance() {
  return useContext(PerformanceContext);
}
