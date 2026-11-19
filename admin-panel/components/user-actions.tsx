import {
  forceLogoutAction,
  restoreAction,
  softDeleteAction,
  suspendAction,
  unsuspendAction,
  warnAction,
} from "@/app/(panel)/users/[id]/actions";
import type { AdminRole, UserStatus } from "@/lib/types";

/**
 * The account actions for one user. What is shown follows the user's state and the admin's role,
 * and the backend enforces both again. Destructive actions need a typed confirmation.
 */
export function UserActions({
  userId,
  username,
  status,
  role,
}: {
  userId: string;
  username: string;
  status: UserStatus;
  role: AdminRole;
}) {
  const support = role === "support" || role === "superadmin";
  const expected = username || userId;

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>Actions</h2>

      {status === "deleted" ? (
        support ? (
          <form action={restoreAction} className="toolbar">
            <input type="hidden" name="userId" value={userId} />
            <span className="muted">This account is deleted. Restoring brings it back.</span>
            <button type="submit">Restore account</button>
          </form>
        ) : (
          <p className="muted">This account is deleted. Only support can restore it.</p>
        )
      ) : (
        <>
          {status === "suspended" ? (
            <form action={unsuspendAction} className="toolbar">
              <input type="hidden" name="userId" value={userId} />
              <button type="submit" className="secondary">
                Lift suspension
              </button>
            </form>
          ) : (
            <form action={suspendAction} className="toolbar">
              <input type="hidden" name="userId" value={userId} />
              <label>
                Suspend until (UTC, end of day)
                <input name="until" type="date" />
              </label>
              <label>
                Reason
                <input name="reason" required maxLength={500} size={36} />
              </label>
              <button type="submit" className="secondary">
                Suspend
              </button>
            </form>
          )}

          <form action={warnAction} className="toolbar">
            <input type="hidden" name="userId" value={userId} />
            <label>
              Warning (sent as a Moderation DM)
              <input name="message" required maxLength={1000} size={48} />
            </label>
            <button type="submit" className="secondary">
              Send warning
            </button>
          </form>

          {support ? (
            <>
              <form action={forceLogoutAction} className="toolbar">
                <input type="hidden" name="userId" value={userId} />
                <span className="muted">Ends every session on every device.</span>
                <button type="submit" className="secondary">
                  Sign out everywhere
                </button>
              </form>

              <form action={softDeleteAction} className="toolbar">
                <input type="hidden" name="userId" value={userId} />
                <label>
                  Reason
                  <input name="reason" required maxLength={500} size={28} />
                </label>
                <label>
                  Type <code>{expected}</code> to confirm
                  <input name="confirm" required size={20} />
                </label>
                <button type="submit" style={{ background: "var(--danger)" }}>
                  Delete account
                </button>
              </form>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
