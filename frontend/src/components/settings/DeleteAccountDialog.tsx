"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { useAuth } from "@/contexts/auth-context";
import { ApiError } from "@/lib/api/client";
import { deleteAccount } from "@/lib/api/auth";

export interface DeleteAccountDialogProps {
  onClose: () => void;
}

const CONSEQUENCES = [
  "You leave every chat, group, and channel",
  "Your sticker packs, clips, and wallpapers are deleted",
  "Your profile is anonymized — messages you've sent stay, shown as “Deleted User”",
];

// Two steps, not one — this is the one genuinely irreversible action in
// Settings (everything else here is undoable: unblock, change the password
// back, flip a toggle). The backend's own re-auth requirement (current
// password) is the real gate; the first step just makes sure a stray tap
// can't reach that password field by accident.
export function DeleteAccountDialog({ onClose }: DeleteAccountDialogProps) {
  const { user, logout } = useAuth();
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => deleteAccount(password),
    // Deleting revokes every session, this device's included (unlike
    // change-password, which keeps this device's refresh token alive) —
    // there's no token left to salvage, so this has to be a real logout.
    onSuccess: () => logout(),
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : "Couldn't delete your account. Check your connection and try again."),
  });

  function submit() {
    if (!password) return;
    setError(null);
    mutation.mutate();
  }

  if (!confirmed) {
    return (
      <Dialog
        onClose={onClose}
        title={<span className="text-danger">Delete your account?</span>}
        description="This can't be undone."
        footer={
          <>
            <Button variant="secondary" onClick={onClose} data-autofocus>
              Keep my account
            </Button>
            <Button variant="danger" onClick={() => setConfirmed(true)}>
              Continue
            </Button>
          </>
        }
      >
        <div className="flex gap-3 rounded-[var(--radius-md)] bg-danger-soft p-4 text-[14px] leading-relaxed text-fg">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" strokeWidth={1.8} aria-hidden />
          <ul className="flex list-disc flex-col gap-1.5 ps-4">
            {CONSEQUENCES.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      onClose={onClose}
      onSubmit={submit}
      title={<span className="text-danger">Confirm with your password</span>}
      description="This is permanent and signs you out on every device."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={mutation.isPending} disabled={!password}>
            Delete my account
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Current password" error={error ?? undefined}>
          <PasswordInput
            name="current-password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            invalid={!!error}
            autoFocus
            required
          />
        </Field>
        {/* Lets password managers offer the saved password for this account. */}
        <input type="text" name="username" autoComplete="username" value={user?.username ?? ""} readOnly hidden />
      </div>
    </Dialog>
  );
}
