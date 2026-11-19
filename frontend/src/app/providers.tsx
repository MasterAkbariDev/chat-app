"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ThemeProvider } from "@/contexts/theme-context";
import { PerformanceProvider } from "@/contexts/performance-context";
import { AuthProvider } from "@/contexts/auth-context";
import { PresenceProvider } from "@/contexts/presence-context";
import { CallProvider } from "@/contexts/call-context";
import { ApiError } from "@/lib/api/client";
import { NavigationProgress } from "@/components/NavigationProgress";

function shouldRetry(failureCount: number, error: unknown) {
  // Don't burn retries on errors a retry can't fix (auth/permission/4xx).
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: shouldRetry },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <NavigationProgress />
      <ThemeProvider>
        <PerformanceProvider>
        <AuthProvider>
          <PresenceProvider>
            <CallProvider>{children}</CallProvider>
          </PresenceProvider>
        </AuthProvider>
        </PerformanceProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
