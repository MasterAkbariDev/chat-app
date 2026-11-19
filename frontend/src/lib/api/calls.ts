import { apiFetch } from "./client";

/** Mirrors the backend's `JoinCallResult` (calls.service.ts) exactly — the
 * same shape comes back from both create and join. `roomToken` is a
 * short-lived (10 min) LiveKit `AccessToken.toJwt()`; `roomName` is
 * `call-${callId}`; `livekitUrl` is the self-hosted LiveKit deployment's own
 * websocket URL, not a LiveKit Cloud one. */
export interface JoinCallResult {
  callId: string;
  roomName: string;
  roomToken: string;
  livekitUrl: string;
}

/** Rings every other member of `channelId` (private: the one other member;
 * group: every other joined member) and returns a room token for the caller.
 * No `callType`/audio-video flag exists server-side — that choice is made
 * entirely client-side when publishing local tracks. */
export function createCall(channelId: string) {
  return apiFetch<JoinCallResult>("/v1/calls", { method: "POST", body: { channelId } });
}

/** Answers a ringing call (or joins an already-active group call). */
export function joinCall(callId: string) {
  return apiFetch<JoinCallResult>(`/v1/calls/${callId}/join`, { method: "POST" });
}

/** A private call always ends the moment either side leaves; a group call
 * ends once everyone has left. */
export function leaveCall(callId: string) {
  return apiFetch<{ success: true }>(`/v1/calls/${callId}/leave`, { method: "POST" });
}

/** Private calls only — before ever joining. */
export function declineCall(callId: string) {
  return apiFetch<{ success: true }>(`/v1/calls/${callId}/decline`, { method: "POST" });
}

export interface IncomingCallInfo {
  callId: string;
  channelId: string;
  fromUserId: string;
  fromUsername: string;
  isPrivate: boolean;
  /** Epoch ms when the ring gives up. */
  expiresAt?: number;
}

/** DM calls ringing me right now — after a reconnect, or when the app was
 * opened from an "Incoming call" notification. */
export function getIncomingCalls() {
  return apiFetch<{ calls: IncomingCallInfo[] }>("/v1/calls/incoming");
}

export interface GroupCallParticipant {
  _id: string;
  name: string;
  /** Only a photo anyone may see. */
  photo: string | null;
}

export interface GroupCallInfo {
  callId: string;
  channelId: string;
  startedAt: number | null;
  participants: GroupCallParticipant[];
}

export const groupCallKey = (channelId: string) => ["group-call", channelId] as const;

/** The live voice chat in a group/channel, or null. */
export function getGroupCall(channelId: string) {
  return apiFetch<{ call: GroupCallInfo | null }>(`/v1/calls/channel/${channelId}`).then((r) => r.call);
}
