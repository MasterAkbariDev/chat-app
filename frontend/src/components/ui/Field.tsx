import { isValidElement, cloneElement, useId, type InputHTMLAttributes, type ReactElement, type TextareaHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/cn";

interface FieldWrapperProps {
  label?: string;
  /** Optional right-aligned element on the label row (e.g. "Forgot password?"). */
  labelAside?: React.ReactNode;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}

/** Label + control + hint/error. The label is a real `<label htmlFor>`,
 * id-linked to its single child control automatically (`useId()` +
 * cloning), and the hint/error is wired to the control's
 * `aria-describedby` so a screen reader announces it with the field. Only
 * applies when `children` is exactly one element — a Field wrapping more
 * than one child is left untouched rather than guessing which child the
 * label describes. A caller-supplied `id` on that child always wins. */
export function Field({ label, labelAside, hint, error, className, children }: FieldWrapperProps) {
  const generatedId = useId();
  const isSingleElement = isValidElement(children);
  const existingId = isSingleElement ? (children.props as { id?: string }).id : undefined;
  const linkId = existingId ?? (isSingleElement ? generatedId : undefined);
  const messageId = `${generatedId}-message`;
  const message = error ?? hint;
  const linkedChildren = isSingleElement
    ? cloneElement(children as ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>, {
        ...(existingId ? {} : { id: generatedId }),
        ...(message ? { "aria-describedby": messageId } : {}),
        ...(error ? { "aria-invalid": true } : {}),
      })
    : children;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label || labelAside ? (
        <div className="flex items-baseline justify-between gap-3">
          {label ? (
            <label htmlFor={linkId} className="text-[13.5px] font-semibold text-fg-2">
              {label}
            </label>
          ) : (
            <span />
          )}
          {labelAside}
        </div>
      ) : null}
      {linkedChildren}
      {message ? (
        <div id={messageId} className={cn("text-[12.5px] leading-snug", error ? "text-danger" : "text-muted")} role={error ? "alert" : undefined}>
          {message}
        </div>
      ) : null}
    </div>
  );
}

const fieldBase = cn(
  "w-full rounded-[var(--radius-sm)] border border-line bg-sunken px-3.5 text-[15px] text-fg outline-none",
  "placeholder:text-muted transition-[border-color,background-color] duration-[var(--dur-fast)]",
  "hover:border-line-strong focus:border-accent focus:bg-raised focus-visible:outline-none",
  "disabled:opacity-60 aria-[invalid=true]:border-danger",
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  ({ className, invalid, ...props }, ref) => (
    <input ref={ref} aria-invalid={invalid || props["aria-invalid"] || undefined} className={cn(fieldBase, "h-11", className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldBase, "min-h-[88px] resize-none py-2.5 leading-relaxed", className)} {...props} />
));
Textarea.displayName = "Textarea";
