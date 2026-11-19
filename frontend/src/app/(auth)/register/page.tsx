"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-app-router";
import { AuthShell } from "@/components/auth/AuthShell";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { useAuth } from "@/contexts/auth-context";
import { ApiError } from "@/lib/api/client";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { register, status } = useAuth();
  const router = useRouter();

  // Already signed in (e.g. a bookmarked /login) — go straight to the chats.
  useEffect(() => {
    if (status === "authenticated") router.replace("/app");
  }, [status, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register({
        email,
        username,
        password,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
      });
      router.push("/app");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="It takes a minute. You'll be signed in straight away."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-accent-text hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        {error ? (
          <div role="alert" className="rounded-[var(--radius-md)] bg-danger-soft p-3.5 text-[14px] text-danger">
            {error}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="First name">
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" autoFocus />
          </Field>
          <Field label="Last name">
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
          </Field>
        </div>

        <Field label="Username" hint="This is how people find and @mention you.">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>

        <Field label="Email">
          <Input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </Field>

        <Field label="Password" hint="At least 6 characters.">
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
            autoComplete="new-password"
          />
        </Field>

        <Button type="submit" size="lg" block loading={submitting} className="mt-1">
          {submitting ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthShell>
  );
}
