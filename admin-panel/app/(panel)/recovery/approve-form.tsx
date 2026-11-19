"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { approveRecoveryAction, type ApproveState } from "./actions";

const initial: ApproveState = {};

/**
 * Approves one request and shows the link once. The link stays in this component's memory only.
 * Closing it, or leaving the page, loses it for good, and the admin can revoke or re-approve.
 */
export function ApproveForm({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(approveRecoveryAction, initial);
  const [copied, setCopied] = useState(false);

  if (state.token) {
    const link = `${state.token}`;
    return (
      <div className="card" role="status">
        <p>
          <strong>Copy this link now.</strong> It is shown only once. Send it to the user out of band,
          then mark it as sent. It expires {state.expiresAt ? new Date(state.expiresAt).toLocaleString("en-GB") : "soon"}.
        </p>
        <p>
          <code style={{ fontSize: 16, userSelect: "all" }}>{link}</code>
        </p>
        <p className="toolbar">
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy code"}
          </button>
          <button type="button" onClick={() => router.refresh()}>
            Done, refresh the queue
          </button>
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="toolbar">
      <input type="hidden" name="requestId" value={requestId} />
      <button type="submit" disabled={pending}>
        {pending ? "Approving…" : "Approve"}
      </button>
      {state.error ? (
        <span className="error" role="alert">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
