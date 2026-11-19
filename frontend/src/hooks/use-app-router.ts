"use client";

import { useMemo } from "react";
import { useRouter as useNextRouter } from "next/navigation";
import { startNavigationProgress } from "@/lib/nav-progress";

/** `next/navigation`'s router, plus a signal to the global progress bar
 * whenever code navigates (link clicks are picked up separately). Use this
 * instead of importing `useRouter` from next/navigation directly. */
export function useRouter() {
  const router = useNextRouter();
  return useMemo(
    () => ({
      ...router,
      push: (...args: Parameters<typeof router.push>) => {
        startNavigationProgress();
        router.push(...args);
      },
      replace: (...args: Parameters<typeof router.replace>) => {
        startNavigationProgress();
        router.replace(...args);
      },
    }),
    [router],
  );
}
