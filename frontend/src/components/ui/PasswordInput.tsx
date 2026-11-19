"use client";

import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "./Field";
import { cn } from "@/lib/cn";

/** A password field with a show/hide toggle. Forwards everything to
 * `Input`, so it drops into `<Field>` (label/hint/error linking) as-is. */
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  ({ className, ...props }, ref) => {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <Input ref={ref} {...props} type={visible ? "text" : "password"} className={cn("pe-12", className)} />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label="Show password"
          aria-pressed={visible}
          title={visible ? "Hide password" : "Show password"}
          className="pressable absolute end-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-line hover:text-fg"
        >
          {visible ? <EyeOff className="size-[18px]" strokeWidth={1.8} /> : <Eye className="size-[18px]" strokeWidth={1.8} />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
