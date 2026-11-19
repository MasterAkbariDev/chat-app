import Link from "next/link";
import { notFound } from "next/navigation";
import { adminFetch, AdminApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { Flash } from "@/components/flash";
import type { AdminRole } from "@/lib/types";
import { replyTicketAction, updateTicketAction } from "../actions";

export const metadata = { title: "Ticket" };

interface TicketDetail {
  id: string;
  subject: string;
  status: string;
  lastActivityAt: string;
  createdAt: string;
  user: { id: string; username: string; email: string; firstName: string; lastName: string } | null;
  assignedTo: { id: string; email: string; role: AdminRole } | null;
  relatedRecoveryRequestId: string | null;
  relatedReportId: string | null;
  messages: Array<{ author: "user" | "admin"; body: string; at: string }>;
}

export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { admin, token } = await requireAdmin();
  const { id } = await params;
  const flash = await searchParams;

  if (admin.role === "moderator") {
    notFound();
  }

  let t: TicketDetail;
  try {
    t = await adminFetch<TicketDetail>(`tickets/${encodeURIComponent(id)}`, { token });
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  return (
    <>
      <p>
        <Link href="/tickets">← Tickets</Link>
      </p>
      <h1>
        {t.subject} <span className="badge">{t.status}</span>
      </h1>
      <Flash ok={flash.ok} error={flash.error} />

      <section className="card">
        <dl className="grid-2 kv">
          <div>
            <dt>User</dt>
            <dd>
              {t.user ? (
                <Link href={`/users/${t.user.id}`}>
                  {t.user.username || t.user.email} — {[t.user.firstName, t.user.lastName].filter(Boolean).join(" ")}
                </Link>
              ) : (
                "(deleted user)"
              )}
            </dd>
          </div>
          <div>
            <dt>Assigned to</dt>
            <dd>{t.assignedTo?.email ?? "Nobody"}</dd>
          </div>
          <div>
            <dt>Opened</dt>
            <dd>{formatDate(t.createdAt)}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>{formatDate(t.lastActivityAt)}</dd>
          </div>
          {t.relatedRecoveryRequestId ? (
            <div>
              <dt>Linked recovery request</dt>
              <dd>
                <Link href="/recovery">{t.relatedRecoveryRequestId}</Link>
              </dd>
            </div>
          ) : null}
          {t.relatedReportId ? (
            <div>
              <dt>Linked report</dt>
              <dd>{t.relatedReportId}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Thread</h2>
        {t.messages.map((m, i) => (
          <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <div className="muted" style={{ fontSize: 12 }}>
              {m.author === "admin" ? "Support" : "User"} · {formatDate(m.at)}
            </div>
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.body}</div>
          </div>
        ))}

        <form action={replyTicketAction} style={{ marginTop: 12, display: "grid", gap: 8 }}>
          <input type="hidden" name="ticketId" value={t.id} />
          <label style={{ display: "grid", gap: 4 }}>
            Reply to the user
            <textarea name="body" required maxLength={4000} rows={4} />
          </label>
          <div>
            <button type="submit">Send reply</button>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            The user gets a short notice in their Moderation DM. The reply itself appears in the ticket thread.
          </p>
        </form>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Status and assignment</h2>
        <form action={updateTicketAction} className="toolbar">
          <input type="hidden" name="ticketId" value={t.id} />
          <label>
            Status
            <select name="status" defaultValue={t.status}>
              <option value="open">Open (needs support)</option>
              <option value="pending">Pending (waiting for user)</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
          <label>
            Assignee
            <select name="assign" defaultValue="">
              <option value="">Leave as is</option>
              <option value="me">Assign to me</option>
              <option value="none">Unassign</option>
            </select>
          </label>
          <label>
            Link recovery request id
            <input name="relatedRecoveryRequestId" size={26} />
          </label>
          <label>
            Link report id
            <input name="relatedReportId" size={26} />
          </label>
          <button type="submit" className="secondary">
            Save
          </button>
        </form>
      </section>
    </>
  );
}
