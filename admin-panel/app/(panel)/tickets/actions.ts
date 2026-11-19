"use server";

import { field, runAdminAction } from "@/lib/admin-action";
import { requireAdmin } from "@/lib/session";

export async function replyTicketAction(formData: FormData) {
  const ticketId = String(formData.get("ticketId"));
  return runAdminAction({
    back: `/tickets/${encodeURIComponent(ticketId)}`,
    path: `tickets/${encodeURIComponent(ticketId)}/messages`,
    body: { body: field(formData, "body") ?? "" },
    okMessage: "Reply sent. The user has been notified.",
  });
}

/** Status, assignee and links. An empty link field leaves that link unchanged. */
export async function updateTicketAction(formData: FormData) {
  const ticketId = String(formData.get("ticketId"));
  const body: Record<string, string | null> = {};
  const status = field(formData, "status");
  if (status) {
    body.status = status;
  }
  const assign = field(formData, "assign");
  if (assign === "me") {
    // Taken from the session, never from the form, so an admin can only assign to themselves.
    const { admin } = await requireAdmin();
    body.assignedTo = admin.adminId;
  } else if (assign === "none") {
    body.assignedTo = null;
  }
  const recovery = field(formData, "relatedRecoveryRequestId");
  if (recovery !== undefined) {
    body.relatedRecoveryRequestId = recovery;
  }
  const report = field(formData, "relatedReportId");
  if (report !== undefined) {
    body.relatedReportId = report;
  }
  return runAdminAction({
    back: `/tickets/${encodeURIComponent(ticketId)}`,
    method: "PATCH",
    path: `tickets/${encodeURIComponent(ticketId)}`,
    body,
    okMessage: "Ticket updated",
  });
}
