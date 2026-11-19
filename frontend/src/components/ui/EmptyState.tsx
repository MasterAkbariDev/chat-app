import type { LucideIcon } from "lucide-react";
import { Button } from "./Button";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("fade-in mx-auto flex max-w-[320px] flex-col items-center px-6 py-10 text-center", className)}>
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent-text">
        <Icon className="size-6" strokeWidth={1.8} aria-hidden />
      </div>
      <div className="text-[16px] font-semibold text-fg">{title}</div>
      {description ? <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{description}</p> : null}
      {action ? (
        <Button size="sm" className="mt-5" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
