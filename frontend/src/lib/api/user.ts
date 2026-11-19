import { apiFetch } from "./client";
import type { Me, ProfilePhoto } from "./types";

export interface UpdateProfileInput {
  firstName?: string;
  lastName?: string;
  username?: string;
  bio?: string;
  /** Profile photo: `[url]` from `uploadImage`, or `[]` to remove it. */
  avatarUrl?: string[];
}

/** `POST /users` (not a REST-conventional PATCH — matches the backend's own route).
 *  Send only the fields being changed; returns the full updated profile. A duplicate
 *  username 400s with "Username is already taken". */
export function updateProfile(input: UpdateProfileInput) {
  return apiFetch<Me>("/users", { method: "POST", body: input });
}

// ---- Profile photos (main first; everyone can browse them) -----------------

export const userPhotosKey = (userId: string) => ["users", userId, "photos"] as const;

export function getUserPhotos(userId: string) {
  return apiFetch<ProfilePhoto[]>(`/users/${userId}/photos`);
}

/** `url` from `uploadImage`, or for a video `uploadAvatarVideo`'s url + posterUrl.
 *  Becomes the main photo unless `makeMain: false`. Returns the new list. Max 100. */
export function addProfilePhoto(input: { url: string; kind?: "image" | "video"; posterUrl?: string; makeMain?: boolean }) {
  return apiFetch<ProfilePhoto[]>("/users/me/photos", { method: "POST", body: input });
}

export function setMainProfilePhoto(photoId: string) {
  return apiFetch<ProfilePhoto[]>(`/users/me/photos/${photoId}/main`, { method: "POST" });
}

export function deleteProfilePhoto(photoId: string) {
  return apiFetch<ProfilePhoto[]>(`/users/me/photos/${photoId}`, { method: "DELETE" });
}
