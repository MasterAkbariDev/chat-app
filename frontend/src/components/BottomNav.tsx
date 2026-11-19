"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, formatBadge, useUnreadChatCount } from "@/components/nav-items";
import { cn } from "@/lib/cn";

/** Phone tab bar — flush to the bottom edge, above the home indicator. */
export function BottomNav() {
  const pathname = usePathname();
  const unread = useUnreadChatCount();

  return (
    <nav aria-label="Main" className="safe-bottom shrink-0 border-t border-line bg-panel">
      <ul className="flex h-16 items-stretch">
        {NAV_ITEMS.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          const badge = item.badge ? unread : 0;
          return (
            <li key={item.href} className="flex flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                aria-label={badge ? `${item.label}, ${badge} unread` : item.label}
                className={cn("pressable focus-inset flex flex-1 flex-col items-center justify-center gap-1", active ? "text-accent-text" : "text-muted")}
              >
                <span className={cn("relative flex h-8 w-14 items-center justify-center rounded-full transition-colors", active && "bg-accent-soft")}>
                  <Icon className="size-[22px]" strokeWidth={active ? 2.2 : 1.8} aria-hidden />
                  {badge ? (
                    <span className="tabular absolute -top-1 end-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-accent-fg ring-2 ring-[var(--panel)]">
                      {formatBadge(badge)}
                    </span>
                  ) : null}
                </span>
                <span className="text-[12px] font-semibold">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
