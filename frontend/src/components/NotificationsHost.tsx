"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@/hooks/use-app-router";
import { usePathname } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { IconButton } from "@/components/ui/IconButton";
import { useRealtimeEvent } from "@/hooks/use-realtime-event";
import { isCallAudioActive } from "@/lib/call-audio-state";
import { useAuth } from "@/contexts/auth-context";
import { CHANNELS_QUERY_KEY, getChannelsMine } from "@/lib/api/chats";
import { buildMessagePreview } from "@/lib/message-preview";
import { applyMessageDeleted } from "@/lib/chat-list";
import { channelDisplayName, senderId, senderName, type ChannelsPage } from "@/lib/api/types";
import { useToastPrefs } from "@/lib/toast-prefs";
import { clearChatNotifications } from "@/lib/notification-clear";
import { syncPushForSignedInUser } from "@/lib/push";
import { PushPrompt, pushQuestionPending } from "@/components/PushPrompt";
import { InstallPrompt } from "@/components/InstallPrompt";
import { registerAppWorker } from "@/lib/install-app";
import { useDragX } from "@/hooks/use-drag-x";

const MAX_VISIBLE = 3;
/** A toast dragged sideways past this many px is dismissed; a shorter drag springs back. */
const SWIPE_DISMISS_PX = 72;
const LEAVE_MS = 200;
const BASE_TITLE = "Chat";

/** A short synthesized "ding," not a real audio asset — this repo has no
 * `/public/sounds/*` despite the original plan referencing one (confirmed:
 * no such directory or file exists anywhere in the frontend). Two Web Audio
 * API oscillator blips instead of shipping a licensed/generated sound file.
 * Browsers block audio before the page's first user gesture — a toast
 * arriving before the user has clicked anything just plays nothing, same
 * as any other autoplay-gated sound; not worked around here. */
function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const now = ctx.currentTime;
    [880, 1108.73].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.09);
      gain.gain.linearRampToValueAtTime(0.15, now + i * 0.09 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.09 + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.2);
    });
    setTimeout(() => ctx.close(), 500);
  } catch {
    // Autoplay-blocked or unsupported — a missed sound isn't worth surfacing.
  }
}

export interface ToastContext {
  /** In-app notifications are switched on in Settings. */
  enabled: boolean;
  /** The message is yours. */
  own: boolean;
  /** The chat it belongs to is the one open right now. */
  inOpenChat: boolean;
  /** You're on the chat list (no conversation open): the list already shows the new message. */
  onChatList: boolean;
  /** The tab is hidden: the tab title's unread count (and push) cover it. */
  tabHidden: boolean;
  muted: boolean;
}

/** Whether a new message earns an in-app toast. Shown only when you're looking at something
 *  else (another chat, Settings, a profile…) and the chat isn't muted. Silent when it's yours,
 *  when it's in the chat you're reading, when you're on the chat list (its row already moved up
 *  and shows the unread badge), when the tab is hidden, or when the chat is muted. */
export function shouldToast(ctx: ToastContext): boolean {
  return ctx.enabled && !ctx.own && !ctx.inOpenChat && !ctx.onChatList && !ctx.tabHidden && !ctx.muted;
}

/** The chat list's own route; a conversation is `/app/c/:id`, every other screen is elsewhere. */
export function isChatListPath(pathname: string | null): boolean {
  return pathname === "/app" || pathname === "/app/";
}

interface AppToast {
  id: string;
  /** Empty for a notice that isn't about opening a chat (a ban). */
  channelId: string;
  title: string;
  body: string;
}

/** Foreground-only toast for a `new_message` arriving on a channel you're
 * NOT currently viewing — no push/FCM registration, no browser Notification
 * permission prompt, purely off the socket connection already open while
 * the tab is up. Mounted once inside AppShell (i.e. only while
 * authenticated) so it fires regardless of which screen — chat list,
 * settings, a *different* conversation — is open when a message lands. */
export function NotificationsHost({ activeChannelId }: { activeChannelId: string | null }) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const toastPrefs = useToastPrefs();
  const queryClient = useQueryClient();
  const [toasts, setToasts] = useState<AppToast[]>([]);
  // Shares the same cache entry every other CHANNELS_QUERY_KEY consumer
  // does (ConversationList, ConversationView, etc.) — this doesn't add a
  // new fetch, just reads what's already kept current.
  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine() });

  // Signed in on a browser that already allows notifications: register its push token for this account
  // (sign-out removes it, so every sign-in puts it back).
  const userId = user?._id;
  // The install suggestion waits for this account's answer to the notification question (not the browser's
  // permission state: "Not now" leaves that at "default").
  const [pushAnsweredFor, setPushAnsweredFor] = useState<string | null>(null);
  const installReady = !!user && (pushAnsweredFor === user._id || !pushQuestionPending(user._id));
  useEffect(() => {
    if (userId) {
      void registerAppWorker();
      void syncPushForSignedInUser().catch(() => {});
    }
  }, [userId]);

  // Coming to the front clears the chat notifications already shown (they're read now), and a tap on
  // a notification (the service worker's "navigate") opens its chat.
  useEffect(() => {
    const onFront = () => {
      if (!document.hidden) void clearChatNotifications();
    };
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: string } | null;
      if (data?.type === "navigate" && typeof data.url === "string") router.push(data.url);
    };
    onFront();
    document.addEventListener("visibilitychange", onFront);
    window.addEventListener("focus", onFront);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      document.removeEventListener("visibilitychange", onFront);
      window.removeEventListener("focus", onFront);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [router]);

  // Blocked or unblocked by someone: the "they've blocked you" state updates at once, in any open chat.
  useRealtimeEvent(
    "user_blocked_you",
    useCallback(
      (payload) => {
        queryClient.setQueryData(["users", "blocked-me", payload.blockedBy], { blocked: true });
      },
      [queryClient],
    ),
  );
  useRealtimeEvent(
    "user_unblocked_you",
    useCallback(
      (payload) => {
        queryClient.setQueryData(["users", "blocked-me", payload.unblockedBy], { blocked: false });
      },
      [queryClient],
    ),
  );

  // Banned from a chat by an admin: the chat leaves the list, an open conversation closes, and the user
  // is told why (the notice doesn't open the chat).
  useRealtimeEvent(
    "chat_banned",
    useCallback(
      (payload) => {
        void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY, exact: true });
        // A direct chat stays open: its conversation shows the text in place of the composer instead.
        const type = queryClient.getQueryData<ChannelsPage>(CHANNELS_QUERY_KEY)?.items.find(c => c.channelId === payload.channelId)?.type;
        if (type === "private") return;
        // A group or channel: back to the main page, with a notice.
        if (window.location.pathname.startsWith(`/app/c/${payload.channelId}`)) router.replace("/app");
        const id = `ban-${payload.channelId}-${Date.now()}`;
        setToasts((prev) => [...prev, { id, channelId: "", title: "You were banned", body: "You can't send messages in that chat anymore." }].slice(-MAX_VISIBLE));
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
      },
      [queryClient, router],
    ),
  );

  // Tab-title unread counter (Q9's own acceptance criteria, never wired):
  // a count of *chats* with something unread, not a message count — F2
  // established there's no cheap per-channel unread count, only the
  // boolean. Only shown while the tab is actually hidden; switching back
  // clears it immediately, same as most mail/chat clients, rather than
  // waiting for the user to actually open something unread.
  useEffect(() => {
    // Muted chats excluded, matching the nav badge (useUnreadChatCount) —
    // the tab title and the badge used to disagree for a muted unread chat.
    const unreadChats = (channelsQuery.data?.items ?? []).filter((c) => c.unread && !c.isMuted).length;
    function apply() {
      document.title = document.hidden && unreadChats > 0 ? `(${unreadChats}) ${BASE_TITLE}` : BASE_TITLE;
    }
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => document.removeEventListener("visibilitychange", apply);
  }, [channelsQuery.data]);
  useEffect(() => () => {
    document.title = BASE_TITLE;
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useRealtimeEvent(
    "new_message",
    useCallback(
      (payload) => {
        const own = !!user && senderId(payload.message.senderId) === user._id;
        if (own) return;
        const isActive = payload.channelId === activeChannelId;

        // Keep the chat list's own cache current from the same event this
        // toast reacts to — otherwise `unread`/`lastMessagePreview` only
        // catch up on a full refetch (list remount, tab revisit, staleTime
        // elapsing). Muting silences the toast below, not this — a muted
        // chat still shows unread, it just doesn't interrupt you.
        if (!isActive) {
          queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (prev) =>
            prev
              ? {
                  ...prev,
                  items: prev.items.map((c) =>
                    c.channelId === payload.channelId
                      ? {
                          ...c,
                          unread: true,
                          lastMessagePreview: buildMessagePreview(payload.message, user?._id),
                          lastMessageAt: payload.message.createdAt,
                          historyCleared: false,
                        }
                      : c,
                  ),
                }
              : prev,
          );
        }
        if (isActive) return;

        // No batch/single-channel-lookup endpoint for this — read whatever
        // the chat list's own query cache already has. If it's never been
        // populated this session (e.g. deep-linked straight into a
        // conversation), `channel` is undefined and the toast just shows
        // with no title/mute info rather than blocking on a fetch.
        const channel = queryClient
          .getQueryData<ChannelsPage>(CHANNELS_QUERY_KEY)
          ?.items.find((c) => c.channelId === payload.channelId);
        const toastOk = shouldToast({
          enabled: toastPrefs.enabled,
          own,
          inOpenChat: isActive,
          onChatList: isChatListPath(pathname),
          tabHidden: typeof document !== "undefined" && document.hidden,
          muted: !!channel?.isMuted,
        });
        if (!toastOk) return;

        const title = channel ? channelDisplayName(channel) : "New message";
        const name = senderName(payload.message.senderId);
        const id = payload.message._id;
        const preview = toastPrefs.showText ? buildMessagePreview(payload.message, user?._id) || "New message" : "New message";
        // A system message's preview already names the actor (describeSystemMessage) —
        // prefixing it with the sender's name again would read as "Alice: Alice changed…".
        const isSystem = payload.message.type === "system" && toastPrefs.showText;
        const toast: AppToast = {
          id,
          channelId: payload.channelId,
          title,
          body: isSystem || title === name ? preview : `${name}: ${preview}`,
        };
        setToasts((prev) => [...prev.filter((t) => t.id !== id), toast].slice(-MAX_VISIBLE));
        // Silent during a call: a Web Audio "ding" mid-call can move a
        // phone's output from the earpiece to the loudspeaker.
        if (toastPrefs.sound && !isCallAudioActive()) playNotificationSound();
        setTimeout(() => dismiss(id), toastPrefs.durationSec * 1000);
      },
      [activeChannelId, user, queryClient, dismiss, pathname, toastPrefs],
    ),
  );

  // A delete for everyone (yours elsewhere, an admin's, a moderator's) moves the chat's
  // preview back to the previous message — patched in place from the broadcast's recomputed
  // summary, then one debounced refetch to pick up your own delete-for-me override.
  const deleteRefetchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (deleteRefetchRef.current) clearTimeout(deleteRefetchRef.current);
  }, []);
  useRealtimeEvent(
    "message_deleted",
    useCallback(
      (payload) => {
        const prev = queryClient.getQueryData<ChannelsPage>(CHANNELS_QUERY_KEY);
        const next = applyMessageDeleted(prev, payload);
        if (next === prev) return;
        queryClient.setQueryData(CHANNELS_QUERY_KEY, next);
        if (deleteRefetchRef.current) clearTimeout(deleteRefetchRef.current);
        deleteRefetchRef.current = setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY, exact: true });
        }, 600);
      },
      [queryClient],
    ),
  );

  // The live region stays mounted (empty) so screen readers are already
  // watching it when the first toast lands — a region inserted together
  // with its content often isn't announced.
  return (
    <>
    {user ? <PushPrompt key={user._id} userId={user._id} onDone={() => setPushAnsweredFor(user._id)} /> : null}
    {installReady ? <InstallPrompt key={user?._id} /> : null}
    <div
      role="status"
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-3 pt-[max(12px,env(safe-area-inset-top))] empty:hidden"
    >
      {toasts.map((t) => (
        <ToastCard
          key={t.id}
          toast={t}
          onOpen={() => {
            dismiss(t.id);
            if (t.channelId) router.push(`/app/c/${t.channelId}`);
          }}
          onDismiss={() => dismiss(t.id)}
        />
      ))}
    </div>
    </>
  );
}

/** One pop-up. Drag it sideways to dismiss it (past SWIPE_DISMISS_PX); a shorter drag springs
 *  back, and a tap opens the chat. Vertical moves are a scroll and never move it. */
function ToastCard({ toast, onOpen, onDismiss }: { toast: AppToast; onOpen: () => void; onDismiss: () => void }) {
  const [leaving, setLeaving] = useState<-1 | 0 | 1>(0);
  // A drag that just ended must not also count as a tap on the card.
  const draggedRef = useRef(false);
  const { dragging, delta, handlers } = useDragX({
    onEnd: (d) => {
      draggedRef.current = Math.abs(d) > 6;
      if (Math.abs(d) < SWIPE_DISMISS_PX) return;
      setLeaving(d > 0 ? 1 : -1);
      window.setTimeout(onDismiss, LEAVE_MS);
    },
  });
  const offset = leaving ? leaving * 480 : delta;
  return (
    <div
      className="pointer-events-auto w-full max-w-[420px]"
      style={{
        transform: `translateX(${offset}px)`,
        opacity: leaving ? 0 : 1 - Math.min(Math.abs(offset) / 260, 0.6),
        transition: dragging ? "none" : `transform ${LEAVE_MS}ms var(--ease-out), opacity ${LEAVE_MS}ms var(--ease-out)`,
        touchAction: "pan-y",
      }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerLeave={handlers.onPointerLeave}
      onPointerCancel={handlers.onPointerCancel}
    >
      <div className="pop-in flex w-full items-center overflow-hidden rounded-[var(--radius-md)] border border-line bg-raised shadow-lg" style={{ transformOrigin: "top" }}>
        <button
          type="button"
          onClick={() => {
            if (draggedRef.current) return;
            onOpen();
          }}
          className="focus-inset flex min-w-0 flex-1 items-center gap-3 py-3 pe-2 ps-3.5 text-start transition-colors hover:bg-sunken"
        >
          <Avatar colorId={toast.channelId} name={toast.title} size={40} />
          <span className="min-w-0 flex-1">
            <span dir="auto" className="block truncate text-start text-[15px] font-semibold text-fg">
              {toast.title}
            </span>
            <span dir="auto" className="block truncate text-start text-[13.5px] text-muted">
              {toast.body}
            </span>
          </span>
        </button>
        <IconButton aria-label={`Dismiss notification from ${toast.title}`} size="sm" className="me-2" onClick={onDismiss}>
          <X strokeWidth={2} aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}
