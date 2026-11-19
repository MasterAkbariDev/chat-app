"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/hooks/use-app-router";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { resetPasswordWithRecoveryToken, validateRecoveryToken } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";

function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  // Only actually "checking" when there's a token worth validating — a
  // missing token is known-invalid synchronously, computed here rather
  // than set from inside the effect below (same reasoning as the auth
  // context's session-restore initializer: avoids an extra render for a
  // case that isn't actually async).
  const [checking, setChecking] = useState(() => !!token);
  const [valid, setValid] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    validateRecoveryToken(token)
      .then((res) => setValid(res.valid))
      .catch(() => setValid(false))
      .finally(() => setChecking(false));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await resetPasswordWithRecoveryToken(token, password);
      router.push("/login?reset=1");
    } catch (err) {
      // A single-use token that gets raced (e.g. submitted twice) fails here
      // even though validateRecoveryToken said it was fine a moment ago —
      // that's the backend's own single-use guarantee, not a bug.
      // Only a real server rejection means the link is spent — a network
      // failure used to swap the form for "This link can't be used" too,
      // stranding someone whose link was still perfectly good.
      if (err instanceof ApiError) {
        setValid(false);
        setError(err.message);
      } else {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <div className="flex flex-col gap-5" role="status" aria-label="Checking your link">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (!valid) {
    return (
      <div className="flex flex-col gap-5">
        <div role="alert" className="flex items-start gap-3.5 rounded-[var(--radius-md)] bg-danger-soft p-4 text-danger">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" strokeWidth={1.8} aria-hidden />
          <div className="text-[14.5px] leading-relaxed">
            <div className="font-bold">This link can&apos;t be used</div>
            {error ?? "Reset links work once and expire. Ask for a new one to continue."}
          </div>
        </div>
        <Button size="lg" block onClick={() => router.push("/forgot-password")}>
          Ask for a new link
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <Field label="New password" hint="At least 6 characters.">
        <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} required autoFocus autoComplete="new-password" />
      </Field>
      <Field label="Confirm new password" error={error ?? undefined}>
        <PasswordInput
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={6}
          required
          autoComplete="new-password"
          invalid={!!error}
        />
      </Field>
      <Button type="submit" size="lg" block loading={submitting} className="mt-1">
        Save new password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthShell
      title="Set a new password"
      subtitle="Choose something you haven't used here before."
      footer={
        <Link href="/login" className="inline-flex items-center gap-1.5 font-semibold text-accent-text hover:underline">
          <ArrowLeft className="size-4 rtl:rotate-180" strokeWidth={2} aria-hidden />
          Back to sign in
        </Link>
      }
    >
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
