"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/hooks/use-app-router";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { AuthShell } from "@/components/auth/AuthShell";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { SuspendedNotice } from "@/components/SuspendedNotice";
import { useAuth } from "@/contexts/auth-context";
import { ApiError } from "@/lib/api/client";

// Both states below are real, verified backend behavior (auth.service.ts
// validateUser) — not fabricated UI: a 403 with "Too many failed login
// attempts" means a 15-minute lockout after 5 wrong passwords; a 403 with
// "suspended" means an admin suspended the account (this can also interrupt
// an already-open session, not just sign-in, but there's no in-app appeal
// flow either way).
function parseAuthBlock(err: unknown): { kind: "lockout" | "suspended"; message: string } | null {
  if (!(err instanceof ApiError) || err.status !== 403) return null;
  if (/suspend/i.test(err.message)) return { kind: "suspended", message: err.message };
  if (/failed login attempts/i.test(err.message)) return { kind: "lockout", message: err.message };
  return null;
}

function LoginForm() {
  const [mode, setMode] = useState<"email" | "phone">("email");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [block, setBlock] = useState<{ kind: "lockout" | "suspended"; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { login, status } = useAuth();
  const router = useRouter();

  // Already signed in (e.g. a bookmarked /login) — go straight to the chats.
  useEffect(() => {
    if (status === "authenticated") router.replace("/app");
  }, [status, router]);
  const justReset = useSearchParams().get("reset") === "1";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBlock(null);
    setSubmitting(true);
    try {
      await login({
        email: mode === "email" ? identifier : undefined,
        phoneNumber: mode === "phone" ? identifier : undefined,
        password,
      });
      router.push("/app");
    } catch (err) {
      const blocked = parseAuthBlock(err);
      if (blocked) setBlock(blocked);
      else setError(err instanceof ApiError ? err.message : "Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (block?.kind === "suspended") {
    return <SuspendedNotice actionLabel="Back to sign in" onAction={() => setBlock(null)} />;
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to pick up your conversations."
      footer={
        <>
          New to Chat?{" "}
          <Link href="/register" className="font-semibold text-accent-text hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate={false}>
        {justReset && !error && !block ? (
          <div role="status" className="flex items-start gap-3 rounded-[var(--radius-md)] bg-success-soft p-3.5 text-[14px] text-success">
            <CheckCircle2 className="mt-0.5 size-[18px] shrink-0" strokeWidth={2} aria-hidden />
            <span>Your password was changed. Sign in with the new one.</span>
          </div>
        ) : null}

        <SegmentedTabs
          aria-label="Sign in with"
          options={[
            { key: "email", label: "Email" },
            { key: "phone", label: "Phone" },
          ]}
          value={mode}
          onChange={(next) => {
            setMode(next);
            setIdentifier("");
            setError(null);
          }}
        />

        {block?.kind === "lockout" ? (
          <div role="alert" className="flex items-start gap-3 rounded-[var(--radius-md)] bg-danger-soft p-3.5 text-[14px] leading-relaxed text-danger">
            <AlertTriangle className="mt-0.5 size-[18px] shrink-0" strokeWidth={2} aria-hidden />
            <div>
              <div className="font-bold">Too many attempts</div>
              {block.message}
            </div>
          </div>
        ) : null}

        <Field label={mode === "email" ? "Email" : "Phone number"}>
          <Input
            type={mode === "email" ? "email" : "tel"}
            inputMode={mode === "email" ? "email" : "tel"}
            placeholder={mode === "email" ? "you@example.com" : "+98 912 000 0000"}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            autoFocus
            autoComplete={mode === "email" ? "email" : "tel"}
          />
        </Field>

        <Field
          label="Password"
          error={error ?? undefined}
          labelAside={
            <Link href="/forgot-password" className="text-[13.5px] font-semibold text-accent-text hover:underline">
              Forgot password?
            </Link>
          }
        >
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            invalid={!!error}
          />
        </Field>

        <Button type="submit" size="lg" block loading={submitting} className="mt-1">
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
