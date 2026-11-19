/**
 * Domain event names + payloads emitted via `EventEmitter2`. First consumer is
 * `ChatStateListener` (keeps `chat_state` denormalized for the `/v1/channels/mine` aggregation)
 * — see docs/plans/BACKEND_PLAN.md B2. Kept in one file so every emitter/listener pair agrees on
 * the exact shape.
 */

export const MESSAGE_CREATED = "message.created";
export const MESSAGE_DELETED = "message.deleted";
export const MEMBERSHIP_CHANGED = "membership.changed";

export interface MessageCreatedEvent {
  channelId: string;
  createdAt: Date;
  preview: string;
  /** Added for B7 (notifications) — the second consumer of this event, `NotificationService`,
   *  needs to know who sent it (to exclude them from recipients) and who was @mentioned (for
   *  the `notificationLevel: "mentions"` filter). Optional so a caller that doesn't have them
   *  yet doesn't have to fabricate a value. */
  senderId?: string;
  messageId?: string;
  mentions?: string[];
}

export interface MessageDeletedEvent {
  channelId: string;
}

/** A member hid messages for themselves only ("delete for me") — their own chat list
 *  preview may now need to point at an earlier message. */
export const MESSAGE_DELETED_FOR_ME = "message.deleted_for_me";

export interface MessageDeletedForMeEvent {
  channelId: string;
  userId: string;
}

export interface MembershipChangedEvent {
  channelId: string;
}

export const MESSAGES_READ = "messages.read";

/** A member's read pointer moved to the message created at `upToCreatedAt` (mark-read).
 *  Consumed by `MessageInfoService` to record per-message read times. */
export interface MessagesReadEvent {
  channelId: string;
  userId: string;
  upToCreatedAt: Date;
  readAt: Date;
}

export const CALL_RINGING = "call.ringing";
export const CALL_RING_STOPPED = "call.ring_stopped";

/** A DM call started ringing `calleeIds` — `NotificationService` sends each a high-priority
 *  "incoming call" push, so a phone/browser with no live socket still rings. */
export interface CallRingingEvent {
  callId: string;
  channelId: string;
  callerId: string;
  callerName: string;
  calleeIds: string[];
  /** Epoch ms when the ring gives up. */
  expiresAt: number;
}

/** The ring stopped (answered, declined, cancelled, timed out) — the push notification it
 *  raised is withdrawn on every device. */
export interface CallRingStoppedEvent {
  callId: string;
  channelId: string;
  userIds: string[];
  reason: "answered" | "declined" | "missed" | "ended";
}
