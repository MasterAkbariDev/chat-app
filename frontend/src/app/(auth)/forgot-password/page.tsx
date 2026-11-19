"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, MailCheck } from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { requestRecovery } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestRecovery(identifier);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title={sent ? "Request sent" : "Forgot your password?"}
      subtitle={
        sent
          ? undefined
          : "Tell us which account it is. An admin reviews every request and will send you a one-time reset link."
      }
      footer={
        <Link href="/login" className="inline-flex items-center gap-1.5 font-semibold text-accent-text hover:underline">
          <ArrowLeft className="size-4 rtl:rotate-180" strokeWidth={2} aria-hidden />
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <div role="status" className="flex items-start gap-3.5 rounded-[var(--radius-md)] border border-line bg-panel p-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
            <MailCheck className="size-5" strokeWidth={1.8} aria-hidden />
          </span>
          <p className="text-[14.5px] leading-relaxed text-fg-2">
            If that account exists, an admin will review your request and contact you with a reset link. There&apos;s
            nothing else you need to do here.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <Field label="Email, phone number or username" error={error ?? undefined}>
            <Input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              invalid={!!error}
            />
          </Field>
          <Button type="submit" size="lg" block loading={submitting}>
            Send request
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
