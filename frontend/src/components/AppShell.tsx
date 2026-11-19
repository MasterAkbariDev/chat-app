"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@/hooks/use-app-router";
import { ConversationList } from "@/components/chat/ConversationList";
import { BottomNav } from "@/components/BottomNav";
import { NowPlayingBar, PlaybackHost } from "@/components/media/NowPlayingBar";
import { NavRail } from "@/components/NavRail";
import { CommandPalette } from "@/components/CommandPalette";
import { NotificationsHost } from "@/components/NotificationsHost";
import { ResyncHost } from "@/components/ResyncHost";
import { SuspendedNotice } from "@/components/SuspendedNotice";
import { CallOverlay } from "@/components/calls/CallOverlay";
import { Skeleton, SkeletonList } from "@/components/ui/Skeleton";
import { useAuth } from "@/contexts/auth-context";
import { useChatMetaEvents } from "@/hooks/use-chat-meta-events";
import { useVisualViewport } from "@/hooks/use-visual-viewport";
import { cn } from "@/lib/cn";

/** An invite link (chat or pack) opened while signed out: remembered here (the login page
 * always lands on /app) and resumed once signed in. */
const RESUME_KEY = "chat:resume-path";

// A single ConversationList mount shared between the mobile full-screen list
// and the desktop rail (docs/FEATURE_INVENTORY.md flagged the old app for
// rendering the list twice — this shell is deliberately built to avoid that).
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isListRoute = pathname === "/app";
  const isChatRoom = pathname.startsWith("/app/c/");
  const isBotConversation = /^\/app\/settings\/bots\/[^/]+\/?$/.test(pathname);
  // Full-screen flows (a conversation and its info/members screens, the
  // new-chat composer) replace the tab bar on phones, like every native
  // messenger; top-level tabs and settings keep it.
  const showBottomNav = !isChatRoom && !isBotConversation && !pathname.startsWith("/app/new");
  const activeChannelId = isChatRoom ? (pathname.split("/")[3] ?? null) : null;
  const { status, suspended, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // Suspension also fails the profile-restore call in AuthProvider (any
    // ApiError does, not just a real 401), which flips `status` to
    // "unauthenticated" same as a dead session would — without the
    // `!suspended` guard here, this effect races the render below and
    // bounces to /login before the user ever sees the blocking screen.
    if (status === "unauthenticated" && !suspended) {
      if (pathname.startsWith("/app/join/") || pathname.startsWith("/app/addpack/")) {
        try {
          sessionStorage.setItem(RESUME_KEY, pathname);
        } catch {}
      }
      router.replace("/login");
    }
    if (status === "authenticated") {
      let resume: string | null = null;
      try {
        resume = sessionStorage.getItem(RESUME_KEY);
        sessionStorage.removeItem(RESUME_KEY);
      } catch {}
      if ((resume?.startsWith("/app/join/") || resume?.startsWith("/app/addpack/")) && resume !== pathname) router.replace(resume);
    }
  }, [status, suspended, router, pathname]);

  // Group/channel details, roles and admin-mutes, kept live for every screen.
  useChatMetaEvents();
  // On-screen keyboard: `--kb-inset` + `data-keyboard` on <html>.
  useVisualViewport();

  // An admin can suspend an account mid-session, not just at sign-in (a
  // real, verified backend condition — see client.ts's `setOnSuspended`) —
  // checked before the loading/auth gate below since it can flip true while
  // `status` is still "authenticated".
  if (suspended) {
    return <SuspendedNotice actionLabel="Log out" onAction={logout} />;
  }

  // There's no server-side session check yet (the backend hands back a
  // bearer token, not a cookie — see docs/plans/FRONTEND_PLAN.md's F4 for
  // the planned cookie-session work), so this gate is client-side only and
  // briefly waits here while the stored token is verified against
  // POST /auth/profile. A blank "Loading…" screen would still flash on
  // every hard load of an authenticated route (not just after a login
  // redirect) — this renders the real shell's shape instead (NavRail is
  // static/no-fetch, so it's safe before `status` resolves) so the flash
  // reads as "the app is loading in" rather than a dead screen. It doesn't
  // eliminate the round trip itself — only F4's server-side check can.
  if (status !== "authenticated") {
    return (
      <div className="flex h-[calc(100dvh-var(--kb-inset,0px))] bg-canvas" aria-busy="true">
        <NavRail ready={false} />
        <div className="flex w-full flex-col border-e border-line bg-panel lg:w-[var(--list-w)] lg:shrink-0">
          <div className="flex h-[var(--header-h)] items-center px-4">
            <Skeleton className="h-6 w-24" />
          </div>
          <div className="px-4 pb-3">
            <Skeleton className="h-10 w-full rounded-[var(--radius-sm)]" />
          </div>
          <SkeletonList count={7} className="px-2" />
        </div>
        <div className="hidden min-w-0 flex-1 lg:flex" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-var(--kb-inset,0px))] flex-col bg-canvas">
      {/* Visually hidden until focused (first Tab stop) — jumps past the
       * nav rail and chat list straight to the open conversation/page.
       * Not rendered below lg on the list route: <main> is display:none
       * there (the list *is* the page), so the link pointed at nothing. */}
      <a
        href="#main-content"
        className={cn(
          "sr-only rounded-[var(--radius-sm)] bg-accent px-4 py-2.5 text-[14px] font-semibold text-accent-fg focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[100]",
          isListRoute && "max-lg:hidden",
        )}
      >
        Skip to content
      </a>
      <div className="flex min-h-0 flex-1">
        <NavRail />
        <aside
          aria-label="Chats"
          className={cn(isListRoute ? "flex" : "hidden", "min-w-0 w-full border-line lg:flex lg:w-[var(--list-w)] lg:shrink-0 lg:border-e")}
        >
          <ConversationList />
        </aside>
        <main
          id="main-content"
          tabIndex={-1}
          className={cn(isListRoute ? "hidden lg:flex" : "flex", "min-h-0 min-w-0 flex-1 flex-col outline-none")}
        >
          {/* Inside a chat the strip sits under the chat header (ConversationView). */}
          {!isChatRoom && !isBotConversation ? <NowPlayingBar /> : null}
          {children}
        </main>
      </div>
      {showBottomNav ? (
        // Out of the way while a keyboard is up, so a focused field's screen keeps its height.
        <div className="lg:hidden [html[data-keyboard=open]_&]:hidden">
          <BottomNav />
        </div>
      ) : null}
      <CommandPalette />
      <NotificationsHost activeChannelId={activeChannelId} />
      <ResyncHost />
      <CallOverlay />
      <PlaybackHost />
    </div>
  );
}
