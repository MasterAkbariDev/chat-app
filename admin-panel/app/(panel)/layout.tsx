import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { logoutAction, logoutEverywhereAction } from "./actions";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  // Every panel page goes through here, so each one checks the session with the backend.
  const { admin } = await requireAdmin();
  const canSupport = admin.role === "support" || admin.role === "superadmin";

  return (
    <>
      <header className="topbar">
        <strong>Admin</strong>
        <nav>
          <Link href="/users">Users</Link>
          {canSupport ? <Link href="/recovery">Recovery</Link> : null}
          {canSupport ? <Link href="/tickets">Tickets</Link> : null}
          {admin.role === "superadmin" ? <Link href="/audit">Audit log</Link> : null}
        </nav>
        <span className="spacer" />
        <span className="muted">
          {admin.email} · {admin.role}
        </span>
        <form action={logoutEverywhereAction}>
          <button type="submit" className="secondary">
            Sign out everywhere
          </button>
        </form>
        <form action={logoutAction}>
          <button type="submit" className="secondary">
            Sign out
          </button>
        </form>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
