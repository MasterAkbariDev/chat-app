import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/cn";

export type IconButtonVariant = "ghost" | "subtle" | "accent" | "danger" | /** @deprecated use "ghost" */ "default";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Required: an icon-only control has no other accessible name. Also
   * used as the hover tooltip unless `title` is given. */
  "aria-label": string;
}

const sizeClasses: Record<IconButtonSize, string> = {
  sm: "size-8 [&_svg]:size-[17px]",
  md: "size-10 [&_svg]:size-5",
  lg: "size-11 [&_svg]:size-[22px]",
};

const variantClasses: Record<IconButtonVariant, string> = {
  ghost: "text-fg-2 hover:bg-sunken hover:text-fg aria-pressed:bg-accent-soft aria-pressed:text-accent-text",
  default: "text-fg-2 hover:bg-sunken hover:text-fg aria-pressed:bg-accent-soft aria-pressed:text-accent-text",
  subtle: "bg-sunken text-fg-2 hover:text-fg hover:bg-line",
  accent: "bg-accent text-accent-fg hover:bg-accent-hover",
  danger: "text-danger hover:bg-danger-soft",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant = "ghost", size = "md", type = "button", title, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        title={title ?? props["aria-label"]}
        className={cn(
          "pressable inline-flex shrink-0 items-center justify-center rounded-full disabled:pointer-events-none disabled:opacity-40",
          sizeClasses[size],
          variantClasses[variant],
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
IconButton.displayName = "IconButton";
