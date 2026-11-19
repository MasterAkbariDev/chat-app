"use client";

import { useQuery } from "@tanstack/react-query";
import { MessageCircle, Settings, Users, type LucideIcon } from "lucide-react";
import { CHANNELS_QUERY_KEY, getChannelsMine } from "@/lib/api/chats";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
  /** Show the unread-chats badge on this destination. */
  badge?: boolean;
}

// Only destinations that actually exist. Search lives inline in the chat
// list, not as its own tab.
export const NAV_ITEMS: NavItem[] = [
  { href: "/app", label: "Chats", icon: MessageCircle, match: (p) => p === "/app" || p.startsWith("/app/c/") || p.startsWith("/app/new"), badge: true },
  { href: "/app/contacts", label: "Contacts", icon: Users, match: (p) => p.startsWith("/app/contacts") || p.startsWith("/app/user/") },
  { href: "/app/settings", label: "Settings", icon: Settings, match: (p) => p.startsWith("/app/settings") },
];

/** Number of chats with anything unread (muted chats excluded — muting
 * means "don't nag me"). Reads the same cached query the chat list uses, so
 * this never costs an extra request. */
export function useUnreadChatCount(enabled = true): number {
  const { data } = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine(), enabled });
  return (data?.items ?? []).filter((c) => c.unread && !c.isMuted).length;
}

export function formatBadge(n: number): string {
  return n > 99 ? "99+" : String(n);
}
