import { apiFetch } from "./client";
import type { ContactSummary, ProfileView } from "./types";

/** Exactly one of these — enforced server-side (400 if 0 or 2+), not
 * visible in the DTO/OpenAPI schema, so validate client-side too for a
 * faster error than the round trip. */
export type ContactIdentifier =
  | { userId: string; username?: never; phone?: never; email?: never }
  | { username: string; userId?: never; phone?: never; email?: never }
  | { phone: string; userId?: never; username?: never; email?: never }
  | { email: string; userId?: never; username?: never; phone?: never };

export function getContacts() {
  return apiFetch<ContactSummary[]>("/v1/contacts");
}

export function addContact(input: ContactIdentifier & { customName?: string }) {
  return apiFetch<{ _id: string }>("/v1/contacts", { method: "POST", body: input });
}

export function renameContact(contactId: string, customName: string | null) {
  return apiFetch<{ success: boolean }>(`/v1/contacts/${contactId}`, { method: "PATCH", body: { customName } });
}

/** Idempotent-silent server-side — always {success:true}, even for an
 * already-removed or foreign id. No 404 signal to detect "was already gone". */
export function removeContact(contactId: string) {
  return apiFetch<{ success: boolean }>(`/v1/contacts/${contactId}`, { method: "DELETE" });
}

/** Unversioned. 403s if the target has blocked the caller. phoneNumber/email
 * only present for your own profile or a mutual contact. */
export function getUserProfile(userId: string) {
  return apiFetch<ProfileView>(`/users/by-id/${userId}`);
}
