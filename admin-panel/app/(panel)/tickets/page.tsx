import Link from "next/link";
import { adminFetch } from "@/lib/api";
import { requireAdmin } from "@/lib/session";
import { PAGE_SIZE } from "@/lib/constants";
import { formatDate, pageNumber } from "@/lib/format";
import { Pager } from "@/components/pager";
import type { Paged } from "@/lib/types";

export const metadata = { title: "Support tickets" };

const STATUSES = ["", "open", "pending", "resolved"] as const;

interface TicketRow {
  id: string;
  subject: string;
  status: string;
  lastActivityAt: string;
  messageCount: number;
  user: { id: string; username: string; email: string } | null;
  assignedTo: { id: string; email: string } | null;
}

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; assigned?: string; page?: string }>;
}) {
  const { admin, token } = await requireAdmin();
  const params = await searchParams;

  if (admin.role === "moderator") {
    return (
      <>
        <h1>Support tickets</h1>
        <p className="error">Support tickets are handled by support.</p>
      </>
    );
  }

  const status = (STATUSES as readonly string[]).includes(params.status ?? "") ? params.status : "";
  const assigned = params.assigned === "me" ? "me" : "";
  const page = pageNumber(params.page);
  const data = await adminFetch<Paged<TicketRow>>("tickets", {
    token,
    query: {
      status: status || undefined,
      assignedTo: assigned || undefined,
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
    },
  });

  return (
    <>
      <h1>Support tickets</h1>
      <form className="toolbar" action="/tickets">
        <label>
          Status
          <select name="status" defaultValue={status}>
            {STATUSES.map((s) => (
              <option key={s || "all"} value={s}>
                {s || "All"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assigned
          <select name="assigned" defaultValue={assigned}>
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Subject</th>
              <th>User</th>
              <th>Status</th>
              <th>Assignee</th>
              <th>Messages</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No tickets match.
                </td>
              </tr>
            ) : (
              data.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link href={`/tickets/${t.id}`}>{t.subject}</Link>
                  </td>
                  <td>{t.user?.username || t.user?.email || "(deleted user)"}</td>
                  <td>
                    <span className="badge">{t.status}</span>
                  </td>
                  <td>{t.assignedTo?.email ?? "—"}</td>
                  <td>{t.messageCount}</td>
                  <td>{formatDate(t.lastActivityAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pager basePath="/tickets" params={{ status, assigned }} page={page} total={data.total} />
    </>
  );
}
