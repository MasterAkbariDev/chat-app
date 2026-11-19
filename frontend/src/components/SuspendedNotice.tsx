import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";

/** Where suspended users can appeal; set per deployment. */
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "";

// Extracted from the login page's own suspended-block screen (see that
// page's `parseAuthBlock` comment for the two real, verified backend
// conditions this can come from — sign-in itself, or a request made
// while already signed in getting rejected the same way mid-session).
// Same content either way; only the action button differs.
export function SuspendedNotice({ actionLabel, onAction }: { actionLabel: string; onAction: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div
        role="alert"
        aria-labelledby="suspended-title"
        className="rise-in flex w-full max-w-[420px] flex-col items-center rounded-[var(--radius-lg)] border border-line bg-raised px-6 py-8 text-center sm:px-8"
      >
        <div className="mb-5 flex size-14 items-center justify-center rounded-[var(--radius-md)] bg-danger-soft text-danger">
          <ShieldAlert className="size-7" strokeWidth={1.8} aria-hidden />
        </div>
        <h1 id="suspended-title" className="font-display text-[24px] font-bold leading-tight text-fg">
          Account suspended
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-fg-2">
          An administrator suspended this account for breaking the community guidelines. This can also end a session
          that&apos;s already open, not only at sign-in.
        </p>
        <div className="mt-6 w-full rounded-[var(--radius-md)] bg-sunken px-4 py-3.5 text-start text-[14px] leading-relaxed text-fg-2">
          There&apos;s no way to appeal inside the app.{" "}
          {SUPPORT_EMAIL ? (
            <>
              To dispute this, email{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="font-semibold text-accent-text underline underline-offset-2">
                {SUPPORT_EMAIL}
              </a>
              .
            </>
          ) : (
            "To dispute this, contact whoever runs this server."
          )}
        </div>
        <Button variant="secondary" block className="mt-6" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
