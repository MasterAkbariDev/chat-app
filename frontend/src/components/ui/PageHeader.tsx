"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/cn";

export interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Where "back" goes. Omit for a top-level page (no back button). */
  backHref?: string;
  /** Use instead of backHref when back is an in-page action. */
  onBack?: () => void;
  backLabel?: string;
  /** Show the back button on desktop too (default: only below `lg`, where
   * the page replaces the list instead of sitting beside it). */
  backOnDesktop?: boolean;
  actions?: React.ReactNode;
  className?: string;
}

/** The flush top bar every secondary screen shares (settings, contacts,
 * chat info, new chat…) — same height and hairline as the conversation
 * header, so moving between screens never shifts the layout. */
export function PageHeader({ title, subtitle, backHref, onBack, backLabel = "Back", backOnDesktop, actions, className }: PageHeaderProps) {
  const backClasses = cn(
    "pressable -ms-2 flex size-10 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-sunken hover:text-fg",
    !backOnDesktop && "lg:hidden",
  );
  return (
    <header
      className={cn(
        "safe-top sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b border-line bg-panel/95 px-4 backdrop-blur-sm lg:px-6",
        className,
      )}
    >
      <div className="flex h-[var(--header-h)] min-w-0 flex-1 items-center gap-2">
        {backHref ? (
          <Link href={backHref} aria-label={backLabel} title={backLabel} className={backClasses}>
            <ArrowLeft className="size-5 rtl:rotate-180" strokeWidth={2} />
          </Link>
        ) : onBack ? (
          <button type="button" onClick={onBack} aria-label={backLabel} title={backLabel} className={backClasses}>
            <ArrowLeft className="size-5 rtl:rotate-180" strokeWidth={2} />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-[20px] font-bold leading-tight tracking-[-0.01em]">{title}</h1>
          {subtitle ? <div className="truncate text-[13px] text-muted">{subtitle}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    </header>
  );
}

/** Scrollable body under a PageHeader, with a readable max width. */
export function PageBody({
  children,
  className,
  width = "md",
  footer,
}: {
  children: React.ReactNode;
  className?: string;
  width?: "sm" | "md" | "lg";
  /** Full-width content after the padded column, in the same scroll (e.g. shared media,
   *  which brings its own bottom padding). The scroll box is a CSS container (`cqw`). */
  footer?: React.ReactNode;
}) {
  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-7 px-4 pt-5 lg:px-6 lg:pt-7",
          footer ? "pb-6" : "pb-24 lg:pb-10",
          width === "sm" && "max-w-[480px]",
          width === "md" && "max-w-[640px]",
          width === "lg" && "max-w-[880px]",
          className,
        )}
      >
        {children}
      </div>
      {footer}
    </div>
  );
}
