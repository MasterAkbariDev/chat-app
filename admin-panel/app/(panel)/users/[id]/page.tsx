import Link from "next/link";
import { notFound } from "next/navigation";
import { adminFetch, AdminApiError } from "@/lib/api";
import { requireAdmin } from "@/lib/session";
import { formatDate } from "@/lib/format";
import type { UserDetail } from "@/lib/types";
import { Flash } from "@/components/flash";
import { UserActions } from "@/components/user-actions";

export const metadata = { title: "User" };

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { token, admin } = await requireAdmin();
  const { id } = await params;
  const flash = await searchParams;

  let detail: UserDetail;
  try {
    detail = await adminFetch<UserDetail>(`users/${encodeURIComponent(id)}`, { token });
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) {
      notFound();
    }
    throw error;
  }

  const p = detail.profile;
  return (
    <>
      <p>
        <Link href="/users">← Users</Link>
      </p>
      <h1>
        {p.username || "(no username)"}{" "}
        <span className={`badge ${p.status}`}>{p.status}</span>
      </h1>
      <Flash ok={flash.ok} error={flash.error} />
      <UserActions
        userId={p.id}
        username={p.username}
        status={p.status}
        role={admin.role}
      />

      <section className="card">
        <dl className="grid-2 kv">
          <div>
            <dt>Name</dt>
            <dd>{[p.firstName, p.lastName].filter(Boolean).join(" ") || "—"}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{p.email || "—"}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{p.phoneNumber || "—"}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDate(p.createdAt)}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{formatDate(p.lastSeen)}</dd>
          </div>
          <div>
            <dt>Suspended until</dt>
            <dd>{formatDate(p.suspendedUntil)}</dd>
          </div>
          <div className="wrap">
            <dt>Bio</dt>
            <dd>{p.bio || "—"}</dd>
          </div>
        </dl>
      </section>

      <h2>Channels ({detail.memberships.length})</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Role</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {detail.memberships.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  Not a member of any chat.
                </td>
              </tr>
            ) : (
              detail.memberships.map((m) => (
                <tr key={m.chatId}>
                  <td>{m.name || "(unnamed)"}</td>
                  <td>{m.type}</td>
                  <td>{m.role}</td>
                  <td className="wrap">
                    {[
                      m.isBanned && "banned",
                      m.mutedByAdmin && "muted by admin",
                      m.isChatLocked && "chat locked",
                      m.isChatDeleted && "chat deleted",
                    ]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2>Sessions (latest 20)</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>IP</th>
              <th>Last used</th>
              <th>Signed in</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {detail.sessions.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No sessions.
                </td>
              </tr>
            ) : (
              detail.sessions.map((s) => (
                <tr key={s.id}>
                  <td className="wrap">{s.device || "—"}</td>
                  <td>{s.ip || "—"}</td>
                  <td>{formatDate(s.lastUsedAt)}</td>
                  <td>{formatDate(s.createdAt)}</td>
                  <td>{s.revokedAt ? `revoked ${formatDate(s.revokedAt)}` : "active"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2>Reports (latest 20)</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Target</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Action</th>
              <th>Filed</th>
            </tr>
          </thead>
          <tbody>
            {detail.reports.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No reports involve this user.
                </td>
              </tr>
            ) : (
              detail.reports.map((r) => (
                <tr key={r.id}>
                  <td>{r.role === "reporter" ? "filed by user" : "about user"}</td>
                  <td>
                    {r.targetType} · <span className="muted">{r.targetId}</span>
                  </td>
                  <td className="wrap">{r.reason}</td>
                  <td>{r.status}</td>
                  <td>{r.action ?? "—"}</td>
                  <td>{formatDate(r.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2>Moderation history (latest 50)</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {detail.history.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No admin actions on this user yet.
                </td>
              </tr>
            ) : (
              detail.history.map((h) => (
                <tr key={h.id}>
                  <td>{formatDate(h.at)}</td>
                  <td>{h.actor?.email ?? "(unknown)"}</td>
                  <td>{h.action}</td>
                  <td className="wrap">{h.meta ? JSON.stringify(h.meta) : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
