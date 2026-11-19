import { adminFetch } from "@/lib/api";
import { requireAdmin } from "@/lib/session";
import { PAGE_SIZE } from "@/lib/constants";
import { formatDate, pageNumber } from "@/lib/format";
import { Flash } from "@/components/flash";
import { Pager } from "@/components/pager";
import type { Paged } from "@/lib/types";
import { ApproveForm } from "./approve-form";
import { denyRecoveryAction, markSentAction, revokeTokenAction } from "./actions";

export const metadata = { title: "Recovery" };

type Status = "pending" | "approved" | "denied";
const TABS: Array<{ value: Status; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
];

interface RecoveryItem {
  id: string;
  status: Status;
  requestedAt: string;
  ip: string | null;
  reviewedAt: string | null;
  denyNote: string | null;
  user: {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
    email: string;
    isDeleted: boolean;
    suspendedUntil: string | null;
  } | null;
  token: {
    id: string;
    status: "active" | "used" | "expired" | "revoked";
    expiresAt: string;
    usedAt: string | null;
    revokedAt: string | null;
    sentAt: string | null;
  } | null;
}

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; ok?: string; error?: string }>;
}) {
  const { admin, token } = await requireAdmin();
  const params = await searchParams;

  if (admin.role === "moderator") {
    return (
      <>
        <h1>Password recovery</h1>
        <p className="error">Password recovery is handled by support.</p>
      </>
    );
  }

  const status: Status = TABS.some((t) => t.value === params.status)
    ? (params.status as Status)
    : "pending";
  const page = pageNumber(params.page);
  const data = await adminFetch<Paged<RecoveryItem>>("recovery-requests", {
    token,
    query: { status, limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) },
  });

  return (
    <>
      <h1>Password recovery</h1>
      <Flash ok={params.ok} error={params.error} />
      <nav className="toolbar">
        {TABS.map((t) => (
          <a
            key={t.value}
            href={`/recovery?status=${t.value}`}
            className={t.value === status ? "button" : "button secondary"}
          >
            {t.label}
          </a>
        ))}
      </nav>

      {data.items.length === 0 ? <p className="muted">Nothing here.</p> : null}

      {data.items.map((r) => (
        <section className="card" key={r.id}>
          <dl className="grid-2 kv">
            <div>
              <dt>User</dt>
              <dd>
                {r.user ? (
                  <>
                    <a href={`/users/${r.user.id}`}>{r.user.username || "(no username)"}</a>{" "}
                    <span className="muted">
                      {[r.user.firstName, r.user.lastName].filter(Boolean).join(" ")}
                    </span>
                    <br />
                    {r.user.email}
                    {r.user.isDeleted ? <span className="badge deleted"> deleted</span> : null}
                  </>
                ) : (
                  "(account no longer exists)"
                )}
              </dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>
                {formatDate(r.requestedAt)} · IP {r.ip ?? "unknown"}
              </dd>
            </div>
            {r.reviewedAt ? (
              <div>
                <dt>Reviewed</dt>
                <dd>{formatDate(r.reviewedAt)}</dd>
              </div>
            ) : null}
            {r.denyNote ? (
              <div>
                <dt>Denial note</dt>
                <dd>{r.denyNote}</dd>
              </div>
            ) : null}
            {r.token ? (
              <div>
                <dt>Link</dt>
                <dd>
                  <span className={`badge ${r.token.status === "active" ? "active" : "deleted"}`}>
                    {r.token.status}
                  </span>{" "}
                  expires {formatDate(r.token.expiresAt)}
                  {r.token.sentAt ? ` · sent ${formatDate(r.token.sentAt)}` : " · not marked sent"}
                </dd>
              </div>
            ) : null}
          </dl>

          {r.status === "pending" ? (
            <>
              <ApproveForm requestId={r.id} />
              <form action={denyRecoveryAction} className="toolbar">
                <input type="hidden" name="requestId" value={r.id} />
                <label>
                  Note (internal)
                  <input name="note" maxLength={500} size={40} />
                </label>
                <button type="submit" className="secondary">
                  Deny
                </button>
              </form>
            </>
          ) : null}

          {r.token && r.token.status === "active" ? (
            <div className="toolbar">
              {r.token.sentAt ? null : (
                <form action={markSentAction}>
                  <input type="hidden" name="tokenId" value={r.token.id} />
                  <button type="submit" className="secondary">
                    Mark as sent
                  </button>
                </form>
              )}
              <form action={revokeTokenAction}>
                <input type="hidden" name="tokenId" value={r.token.id} />
                <button type="submit" style={{ background: "var(--danger)" }}>
                  Revoke link
                </button>
              </form>
            </div>
          ) : null}
        </section>
      ))}

      <Pager basePath="/recovery" params={{ status }} page={page} total={data.total} />
    </>
  );
}
