/** A one-line message set by a redirect from a form action (`?ok=` or `?error=`). */
export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (!ok && !error) {
    return null;
  }
  return (
    <p className={error ? "card error" : "card"} role={error ? "alert" : "status"}>
      {error ?? ok}
    </p>
  );
}
