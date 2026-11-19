import { adminFetch } from "@/lib/api";
import { requireAdmin } from "@/lib/session";
import { PAGE_SIZE } from "@/lib/constants";
import { formatDate, pageNumber } from "@/lib/format";
import type { AuditEntry, Paged } from "@/lib/types";
import { Pager } from "@/components/pager";

export const metadata = { title: "Audit log" };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    action?: string;
    targetType?: string;
    targetId?: string;
    actorId?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  const { admin, token } = await requireAdmin();

  // The backend allows superadmin only; this just avoids a call that would fail.
  if (admin.role !== "superadmin") {
    return (
      <>
        <h1>Audit log</h1>
        <p className="error">Only a superadmin can view the audit log.</p>
      </>
    );
  }

  const params = await searchParams;
  const filters = {
    action: params.action?.trim() || undefined,
    targetType: params.targetType?.trim() || undefined,
    targetId: params.targetId?.trim() || undefined,
    actorId: params.actorId?.trim() || undefined,
    from: params.from || undefined,
    to: params.to || undefined,
  };
  const page = pageNumber(params.page);

  const data = await adminFetch<Paged<AuditEntry>>("audit", {
    token,
    query: {
      ...filters,
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
    },
  });

  return (
    <>
      <h1>Audit log</h1>
      <form className="toolbar" action="/audit">
        <label>
          Action
          <input name="action" defaultValue={filters.action ?? ""} placeholder="user.suspend" />
        </label>
        <label>
          Target type
          <input name="targetType" defaultValue={filters.targetType ?? ""} placeholder="user" />
        </label>
        <label>
          Target id
          <input name="targetId" defaultValue={filters.targetId ?? ""} size={26} />
        </label>
        <label>
          Admin id
          <input name="actorId" defaultValue={filters.actorId ?? ""} size={26} />
        </label>
        <label>
          From
          <input name="from" type="date" defaultValue={params.from ?? ""} />
        </label>
        <label>
          To
          <input name="to" type="date" defaultValue={params.to ?? ""} />
        </label>
        <button type="submit">Apply</button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Admin</th>
              <th>Action</th>
              <th>Target</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No entries match.
                </td>
              </tr>
            ) : (
              data.items.map((e) => (
                <tr key={e.id}>
                  <td>{formatDate(e.at)}</td>
                  <td>
                    {e.actor ? `${e.actor.email} (${e.actor.role})` : "(unknown admin)"}
                  </td>
                  <td>{e.action}</td>
                  <td>
                    {e.targetType} · <span className="muted">{e.targetId}</span>
                  </td>
                  <td className="wrap">{e.meta ? JSON.stringify(e.meta) : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pager
        basePath="/audit"
        params={{
          action: filters.action,
          targetType: filters.targetType,
          targetId: filters.targetId,
          actorId: filters.actorId,
          from: params.from,
          to: params.to,
        }}
        page={page}
        total={data.total}
      />
    </>
  );
}
