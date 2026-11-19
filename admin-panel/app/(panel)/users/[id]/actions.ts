"use server";

import { field, runAdminAction } from "@/lib/admin-action";

/** Each action posts to the user's route and returns to their page with a flash message. */
function userPath(userId: string, action: string) {
  return `users/${encodeURIComponent(userId)}/${action}`;
}

function backTo(userId: string) {
  return `/users/${encodeURIComponent(userId)}`;
}

export async function suspendAction(formData: FormData) {
  const userId = String(formData.get("userId"));
  const day = field(formData, "until");
  // The form takes a calendar date, so the suspension runs to the end of that day in UTC.
  const until = day ? new Date(`${day}T23:59:59.999Z`).toISOString() : undefined;
  return runAdminAction({
    back: backTo(userId),
    path: userPath(userId, "suspend"),
    body: { reason: field(formData, "reason") ?? "", ...(until ? { until } : {}) },
    okMessage: until ? `Suspended until the end of ${day} (UTC)` : "Suspended indefinitely",
  });
}

export async function unsuspendAction(formData: FormData) {
  const userId = String(formData.get("userId"));
  return runAdminAction({
    back: backTo(userId),
    path: userPath(userId, "unsuspend"),
    okMessage: "Suspension lifted",
  });
}

export async function warnAction(formData: FormData) {
  const userId = String(formData.get("userId"));
  return runAdminAction({
    back: backTo(userId),
    path: userPath(userId, "warn"),
    body: { message: field(formData, "message") ?? "" },
    okMessage: "Warning sent",
  });
}

export async function forceLogoutAction(formData: FormData) {
  const userId = String(formData.get("userId"));
  return runAdminAction({
    back: backTo(userId),
    path: userPath(userId, "force-logout"),
    okMessage: "Every session ended",
  });
}

export async function softDeleteAction(formData: FormData) {
  const userId = String(formData.get("userId"));
  return runAdminAction({
    back: backTo(userId),
    path: userPath(userId, "soft-delete"),
    body: {
      reason: field(formData, "reason") ?? "",
      confirm: field(formData, "confirm") ?? "",
    },
    okMessage: "Account deleted (it can be restored)",
  });
}

export async function restoreAction(formData: FormData) {
  const userId = String(formData.get("userId"));
  return runAdminAction({
    back: backTo(userId),
    path: userPath(userId, "restore"),
    okMessage: "Account restored",
  });
}
