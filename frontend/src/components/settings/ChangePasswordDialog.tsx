"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { useAuth } from "@/contexts/auth-context";
import { changePassword } from "@/lib/api/auth";
import { setAccessToken } from "@/lib/api/token-store";
import { ApiError } from "@/lib/api/client";

export interface ChangePasswordDialogProps {
  onClose: () => void;
}

const MIN_LENGTH = 6;

// POST /auth/change-password bumps this user's tokenVersion (invalidating
// every already-issued access token, this device's included) and returns a
// fresh access_token for the calling device — but not a new refresh token.
// Refresh tokens on this backend are opaque, DB-hash-based session rows
// (see token-store.ts), not JWT tokenVersion claims, so the existing refresh
// cookie keeps working; only the access token needs replacing here.
export function ChangePasswordDialog({ onClose }: ChangePasswordDialogProps) {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => changePassword({ currentPassword, newPassword }),
    onSuccess: (res) => setAccessToken(res.access_token),
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : "Couldn't change your password. Check your connection and try again."),
  });

  const confirmMismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit = currentPassword.length > 0 && newPassword.length >= MIN_LENGTH && newPassword === confirmPassword;

  function submit() {
    if (!canSubmit) return;
    setError(null);
    mutation.mutate();
  }

  if (mutation.isSuccess) {
    return (
      <Dialog
        onClose={onClose}
        title="Password changed"
        description="Your other devices have been signed out. Use your new password next time you sign in there."
        footer={
          // Same Dialog instance as the form (so its focus-return target
          // survives), which means its mount-time autofocus never re-runs —
          // the focused field/button just got removed. A fresh keyed button
          // with autoFocus puts focus on "Done" instead of <body>.
          <Button key="done" onClick={onClose} autoFocus>
            Done
          </Button>
        }
      >
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-success-soft px-4 py-3 text-[14px] font-medium text-success">
          <CheckCircle2 className="size-5 shrink-0" strokeWidth={1.8} aria-hidden />
          This device stays signed in.
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      onClose={onClose}
      onSubmit={submit}
      title="Change password"
      description="This signs out every other device you're logged in on."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending} disabled={!canSubmit}>
            Change password
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Current password" error={error ?? undefined}>
          <PasswordInput
            name="current-password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              if (error) setError(null);
            }}
            invalid={!!error}
            autoFocus
            required
          />
        </Field>

        <Field label="New password" hint={`At least ${MIN_LENGTH} characters`}>
          <PasswordInput
            name="new-password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={MIN_LENGTH}
            required
          />
        </Field>

        <Field label="Confirm new password" error={confirmMismatch ? "Passwords don't match — type the new password again" : undefined}>
          <PasswordInput
            name="confirm-password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            invalid={confirmMismatch}
            required
          />
        </Field>

        {/* Lets password managers file the new password under the right
            account. Kept last so the Dialog's autofocus lands on a real field. */}
        <input type="text" name="username" autoComplete="username" value={user?.username ?? ""} readOnly hidden />
      </div>
    </Dialog>
  );
}
