"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { CHANNELS_QUERY_KEY, chatPermissionsKey } from "@/lib/api/chats";
import { useRouter } from "@/hooks/use-app-router";
import type { ChannelsPage, ChatPreview } from "@/lib/api/types";
import { getSocket } from "@/lib/socket";
import { useAuth } from "@/contexts/auth-context";

/** GET /chats/preview/:id — shared by the conversation (non-member preview),
 * the info screen and the join bar. */
export const chatPreviewKey = (channelId: string) => ["chats", channelId, "preview"] as const;
/** GET /chats/:id/members — also where a member learns they've been muted by an admin. */
export const chatManagementKey = (channelId: string) => ["chats", channelId, "management"] as const;
export const chatParticipantsKey = (channelId: string) => ["chats", channelId, "participants"] as const;

interface ChatUpdatedPayload {
  channelId: string;
  name: string;
  description: string | null;
  image: string[];
  isPublic: boolean;
  link: string;
  signature?: boolean;
}

interface RolesUpdatedPayload {
  channelId: string;
  admins: string[];
}

interface PermissionsUpdatedPayload {
  channelId: string;
  /** Set when only this member's exceptions changed. */
  userId?: string;
}

interface ChatDeletedPayload {
  channelId: string;
}

/** Chats deleted while this tab was open — lets the conversation screen say
 *  "This chat no longer exists" instead of "This chat is private". */
const deletedChats = new Set<string>();
export function wasChatDeleted(channelId: string) {
  return deletedChats.has(channelId);
}

/** A short, self-dismissing notice ("This group was deleted"), announced
 *  politely. Imperative because it has to outlive the screen that was
 *  showing the deleted chat. */
export function showTransientNotice(text: string) {
  if (typeof document === "undefined") return;
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.className =
    "pop-in fixed inset-x-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[90] mx-auto w-fit max-w-[420px] rounded-[var(--radius-md)] border border-line bg-raised px-4 py-3 text-[14px] font-medium text-fg shadow-md lg:bottom-6";
  document.body.appendChild(el);
  // Set after insertion so screen readers pick up the change.
  requestAnimationFrame(() => {
    el.textContent = text;
  });
  setTimeout(() => el.remove(), 4500);
}

/** Everything that depends on someone's rights in this chat. */
function refreshPermissions(queryClient: QueryClient, channelId: string) {
  queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: chatPreviewKey(channelId) });
  queryClient.invalidateQueries({ queryKey: chatPermissionsKey(channelId) });
  queryClient.invalidateQueries({ queryKey: chatManagementKey(channelId) });
}

interface UserMutedPayload {
  channelId: string;
  muted: boolean;
}

function onChatUpdated(queryClient: QueryClient, p: ChatUpdatedPayload) {
  const patch = {
    name: p.name,
    description: p.description,
    image: p.image ?? [],
    isPublic: p.isPublic,
    link: p.link,
    ...(p.signature !== undefined ? { signature: p.signature } : {}),
  };
  queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (prev) =>
    prev ? { ...prev, items: prev.items.map((c) => (c.channelId === p.channelId ? { ...c, ...patch } : c)) } : prev,
  );
  queryClient.setQueryData<ChatPreview>(chatPreviewKey(p.channelId), (prev) => (prev ? { ...prev, ...patch } : prev));
  // EditChatDialog's own copy of the preview.
}

function onRolesUpdated(queryClient: QueryClient, p: RolesUpdatedPayload) {
  // `myRole` lives on the channels list and the preview; role badges on the
  // participants list; mute rights on the management list.
  refreshPermissions(queryClient, p.channelId);
  queryClient.invalidateQueries({ queryKey: chatParticipantsKey(p.channelId) });
}

/** Keeps group/channel details and roles live: `chat_updated` (name, photo,
 * description, visibility, link), `channel_roles_updated` (admins changed)
 * `user_muted` (an admin muted or unmuted *you* in a group),
 * `chat_permissions_updated` (member defaults or someone's exceptions) and
 * `chat_deleted` (dropped from the list; if it's open, you're taken back to
 * the chat list with a short notice). Mounted once, in AppShell, so the chat
 * list, conversation, info and members screens all stay current.
 *
 * Subscribes on the raw socket (one effect, one place to unsubscribe) rather
 * than through useRealtimeEvent. */
export function useChatMetaEvents() {
  const queryClient = useQueryClient();
  const { user, status } = useAuth();
  const myId = user?._id;
  const router = useRouter();
  const pathname = usePathname();
  // Read inside the socket handler without resubscribing on every navigation.
  const navRef = useRef({ router, pathname });
  useEffect(() => {
    navRef.current = { router, pathname };
  });

  useEffect(() => {
    if (status !== "authenticated") return;
    const socket = getSocket();
    if (!socket) return;
    const raw = socket as unknown as {
      on: (event: string, fn: (payload: never) => void) => void;
      off: (event: string, fn: (payload: never) => void) => void;
    };
    const handleUpdated = (p: ChatUpdatedPayload) => onChatUpdated(queryClient, p);
    const handleRoles = (p: RolesUpdatedPayload) => onRolesUpdated(queryClient, p);
    const handleMuted = (p: UserMutedPayload) => {
      if (myId) {
        queryClient.setQueryData<{ userId: string; mutedByAdmin: boolean }[]>(chatManagementKey(p.channelId), (prev) =>
          prev ? prev.map((m) => (m.userId === myId ? { ...m, mutedByAdmin: p.muted } : m)) : prev,
        );
      }
      queryClient.invalidateQueries({ queryKey: chatManagementKey(p.channelId) });
    };
    const handlePermissions = (p: PermissionsUpdatedPayload) => refreshPermissions(queryClient, p.channelId);
    const handleDeleted = (p: ChatDeletedPayload) => {
      deletedChats.add(p.channelId);
      const kind = queryClient.getQueryData<ChannelsPage>(CHANNELS_QUERY_KEY)?.items.find((c) => c.channelId === p.channelId)?.type;
      queryClient.setQueryData<ChannelsPage>(CHANNELS_QUERY_KEY, (prev) =>
        prev ? { ...prev, items: prev.items.filter((c) => c.channelId !== p.channelId) } : prev,
      );
      queryClient.removeQueries({ queryKey: ["chats", p.channelId] });
      const { router: r, pathname: path } = navRef.current;
      if (path === `/app/c/${p.channelId}` || path?.startsWith(`/app/c/${p.channelId}/`)) {
        r.push("/app");
        showTransientNotice(kind === "channel" ? "This channel was deleted" : kind === "group" ? "This group was deleted" : "This chat was deleted");
      }
    };
    raw.on("chat_updated", handleUpdated);
    raw.on("chat_permissions_updated", handlePermissions);
    raw.on("chat_deleted", handleDeleted);
    raw.on("channel_roles_updated", handleRoles);
    raw.on("user_muted", handleMuted);
    return () => {
      raw.off("chat_updated", handleUpdated);
      raw.off("chat_permissions_updated", handlePermissions);
      raw.off("chat_deleted", handleDeleted);
      raw.off("channel_roles_updated", handleRoles);
      raw.off("user_muted", handleMuted);
    };
  }, [queryClient, myId, status]);
}
