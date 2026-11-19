import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-soft" | /** @deprecated use "secondary" */ "subtle";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Stretch to the container's width. */
  block?: boolean;
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 gap-1.5 px-3.5 text-[13.5px] rounded-[var(--radius-sm)]",
  md: "h-11 gap-2 px-4 text-[15px] rounded-[var(--radius-sm)]",
  lg: "h-12 gap-2 px-5 text-[16px] rounded-[var(--radius-md)]",
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "bg-sunken text-fg border border-line hover:border-line-strong hover:bg-raised",
  subtle: "bg-sunken text-fg border border-line hover:border-line-strong hover:bg-raised",
  ghost: "bg-transparent text-fg-2 hover:bg-sunken hover:text-fg",
  danger: "bg-danger text-canvas hover:brightness-110",
  "danger-soft": "bg-danger-soft text-danger hover:brightness-[0.97]",
};

/** Class list for anything that should *look* like a Button but isn't a
 * <button> — e.g. a next/link that navigates. Keeps one source of truth. */
export function buttonClasses({
  variant = "primary",
  size = "md",
  block,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; className?: string } = {}) {
  return cn(
    "pressable inline-flex select-none items-center justify-center font-semibold whitespace-nowrap",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    sizeClasses[size],
    variantClasses[variant],
    block && "w-full",
    className,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", block, loading, disabled, children, type = "button", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={buttonClasses({ variant, size, block, className })}
        {...props}
      >
        {loading ? (
          <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
        ) : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
