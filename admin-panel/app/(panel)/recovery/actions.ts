"use server";

import { adminFetch, AdminApiError } from "@/lib/api";
import { field, runAdminAction } from "@/lib/admin-action";
import { requireAdmin } from "@/lib/session";

const BACK = "/recovery";

export async function denyRecoveryAction(formData: FormData) {
  const requestId = String(formData.get("requestId"));
  return runAdminAction({
    back: BACK,
    path: `recovery-requests/${encodeURIComponent(requestId)}/deny`,
    body: { note: field(formData, "note") },
    okMessage: "Request denied",
  });
}

export async function markSentAction(formData: FormData) {
  const tokenId = String(formData.get("tokenId"));
  return runAdminAction({
    back: BACK,
    path: `recovery-tokens/${encodeURIComponent(tokenId)}/mark-sent`,
    okMessage: "Marked as sent",
  });
}

export async function revokeTokenAction(formData: FormData) {
  const tokenId = String(formData.get("tokenId"));
  return runAdminAction({
    back: BACK,
    path: `recovery-tokens/${encodeURIComponent(tokenId)}/revoke`,
    okMessage: "Link revoked",
  });
}

export interface ApproveState {
  error?: string;
  token?: string;
  expiresAt?: string;
}

/**
 * Approves a request and returns the one-time link to the calling component. It is not written to
 * a URL, a cookie or the page's data, so the only copy is the one on screen.
 */
export async function approveRecoveryAction(
  _prev: ApproveState,
  formData: FormData,
): Promise<ApproveState> {
  const requestId = String(formData.get("requestId"));
  const { token } = await requireAdmin();
  try {
    const res = await adminFetch<{ token: string; expiresAt: string }>(
      `recovery-requests/${encodeURIComponent(requestId)}/approve`,
      { token, method: "POST" },
    );
    return { token: res.token, expiresAt: res.expiresAt };
  } catch (error) {
    return {
      error: error instanceof AdminApiError ? error.message : "Could not approve. Try again.",
    };
  }
}
