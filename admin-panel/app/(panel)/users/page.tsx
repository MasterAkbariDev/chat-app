import Link from "next/link";
import { adminFetch } from "@/lib/api";
import { requireAdmin } from "@/lib/session";
import { PAGE_SIZE } from "@/lib/constants";
import { formatDate, pageNumber } from "@/lib/format";
import type { Paged, UserRow, UserStatus } from "@/lib/types";
import { Pager } from "@/components/pager";

export const metadata = { title: "Users" };

const STATUSES: Array<{ value: UserStatus | ""; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "deleted", label: "Deleted" },
];

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const { token } = await requireAdmin();
  const params = await searchParams;
  const q = params.q?.trim() || undefined;
  const status = STATUSES.some((s) => s.value === params.status) ? params.status : undefined;
  const page = pageNumber(params.page);

  const data = await adminFetch<Paged<UserRow>>("users", {
    token,
    query: {
      q,
      status,
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
    },
  });

  return (
    <>
      <h1>Users</h1>
      <form className="toolbar" action="/users">
        <label>
          Search
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="username, email, phone, name"
            size={32}
          />
        </label>
        <label>
          Status
          <select name="status" defaultValue={status ?? ""}>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Status</th>
              <th>Created</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No users match.
                </td>
              </tr>
            ) : (
              data.items.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`/users/${u.id}`}>{u.username || "(no username)"}</Link>
                  </td>
                  <td>{[u.firstName, u.lastName].filter(Boolean).join(" ") || "—"}</td>
                  <td>{u.email || "—"}</td>
                  <td>{u.phoneNumber || "—"}</td>
                  <td>
                    <span className={`badge ${u.status}`}>{u.status}</span>
                  </td>
                  <td>{formatDate(u.createdAt)}</td>
                  <td>{formatDate(u.lastSeen)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pager
        basePath="/users"
        params={{ q, status }}
        page={page}
        total={data.total}
      />
    </>
  );
}
