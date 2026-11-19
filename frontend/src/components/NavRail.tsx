"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircleHeart } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { useAuth } from "@/contexts/auth-context";
import { NAV_ITEMS, formatBadge, useUnreadChatCount } from "@/components/nav-items";
import { cn } from "@/lib/cn";

/** Persistent left rail, desktop only (lg+). Flush with the window edge and
 * the list pane beside it — one continuous surface split by a hairline. */
export function NavRail({ ready = true }: { ready?: boolean }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const unread = useUnreadChatCount(ready);
  const fullName = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username : "";
  const main = NAV_ITEMS.filter((i) => i.href !== "/app/settings");
  const settings = NAV_ITEMS.find((i) => i.href === "/app/settings")!;

  return (
    <nav aria-label="Main" className="hidden w-[var(--rail-w)] shrink-0 flex-col items-center border-e border-line bg-panel py-4 lg:flex">
      <Link href="/app" aria-label="Chat home" className="mb-5 flex size-11 items-center justify-center rounded-[var(--radius-md)] bg-accent text-accent-fg">
        <MessageCircleHeart className="size-[22px]" strokeWidth={2} aria-hidden />
      </Link>

      <ul className="flex flex-col items-center gap-1">
        {main.map((item) => (
          <li key={item.href}>
            <RailLink item={item} active={item.match(pathname)} badge={item.badge ? unread : 0} />
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col items-center gap-3">
        <RailLink item={settings} active={settings.match(pathname)} badge={0} />
        <Link
          href="/app/settings"
          aria-label={fullName ? `Your profile, ${fullName}` : "Your profile"}
          title={fullName || "Your profile"}
          className="rounded-full"
        >
          <Avatar colorId={user?._id ?? "me"} name={fullName} src={user?.avatarUrl?.[0]} size={40} />
        </Link>
      </div>
    </nav>
  );
}

function RailLink({ item, active, badge }: { item: (typeof NAV_ITEMS)[number]; active: boolean; badge: number }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={badge ? `${item.label}, ${badge} unread` : item.label}
      className={cn(
        "pressable group relative flex w-[60px] flex-col items-center gap-1 rounded-[var(--radius-md)] py-2",
        active ? "text-accent-text" : "text-muted hover:text-fg",
      )}
    >
      <span
        className={cn(
          "relative flex h-8 w-12 items-center justify-center rounded-full transition-colors duration-[var(--dur-fast)]",
          active ? "bg-accent-soft" : "group-hover:bg-sunken",
        )}
      >
        <Icon className="size-[21px]" strokeWidth={active ? 2.2 : 1.8} aria-hidden />
        {badge ? (
          <span className="tabular absolute -top-1 end-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-accent-fg ring-2 ring-[var(--panel)]">
            {formatBadge(badge)}
          </span>
        ) : null}
      </span>
      <span className="text-[11.5px] font-semibold">{item.label}</span>
    </Link>
  );
}
