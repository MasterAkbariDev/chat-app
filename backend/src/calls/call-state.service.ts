import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { createRedisClient } from "src/common/redis-client";

const CALL_TTL_SEC = 6 * 60 * 60; // 6h — a call this old is dead regardless; bounds a leaked
// key from a client that never called /leave. Live calls are also reconciled against LiveKit
// by `CallsService.sweep()`, so in practice a dead call is reaped long before this.

export interface CallState {
  callId: string;
  channelId: string;
  isPrivate: boolean;
  initiatorId: string;
  participantIds: string[];
  /** Set the moment a second participant actually joins — "was this call ever answered". */
  startedAt: number | null;
  createdAt: number;
  roomName: string;
  /** Private calls: who is being rung (the callee) — cleared once they answer/decline.
   *  Drives the "pending incoming calls" lookup a reconnecting socket gets. */
  ringingUserIds?: string[];
  /** Private calls: when an unanswered ring gives up and the call is finalized "missed". */
  ringExpiresAt?: number | null;
  /** When each participant got their room token — reconciliation against LiveKit leaves a
   *  participant alone for a short grace period while their client is still connecting. */
  joinedAt?: Record<string, number>;
  /** Display name of whoever started it (group calls: "X started a voice chat"). */
  initiatorName?: string;
}

const keyFor = (callId: string) => `call:${callId}`;
const channelKeyFor = (channelId: string) => `call:byChannel:${channelId}`;
const ringingKeyFor = (userId: string) => `call:ringing:${userId}`;
const finalizeKeyFor = (callId: string) => `call:finalized:${callId}`;
const ACTIVE_SET = "call:active";

/**
 * Call state in Redis, not process memory (B8 — "calls survive an API restart").
 *
 * Keys:
 * - `call:<id>` — the call itself.
 * - `call:byChannel:<channelId>` — the one live call in a chat (a DM allows one at a time; a
 *   group has at most one voice chat everyone joins). Claimed with SET NX, so two people
 *   starting a call in the same chat at the same moment can't create two.
 * - `call:ringing:<userId>` — calls currently ringing that user, so a socket that connects
 *   (or reconnects) after the ring was sent still gets it.
 * - `call:active` — every live call id, walked by the periodic sweep (ring timeout, dead calls).
 * - `call:finalized:<id>` — a short-lived "already ended" lock so a call is finalized (and its
 *   call-log message written) exactly once, even when two requests or instances race.
 */
@Injectable()
export class CallStateService implements OnModuleDestroy {
  private readonly redis = createRedisClient("calls");

  /** Claims the chat's single live-call slot. False when another call already holds it. */
  async claimChannel(channelId: string, callId: string): Promise<boolean> {
    const res = await this.redis.set(
      channelKeyFor(channelId),
      callId,
      "EX",
      CALL_TTL_SEC,
      "NX",
    );
    return res === "OK";
  }

  async create(state: CallState): Promise<void> {
    const multi = this.redis
      .multi()
      .set(keyFor(state.callId), JSON.stringify(state), "EX", CALL_TTL_SEC)
      .sadd(ACTIVE_SET, state.callId);
    for (const userId of state.ringingUserIds ?? []) {
      multi
        .sadd(ringingKeyFor(userId), state.callId)
        .expire(ringingKeyFor(userId), CALL_TTL_SEC);
    }
    await multi.exec();
  }

  async get(callId: string): Promise<CallState | null> {
    const raw = await this.redis.get(keyFor(callId));
    return raw ? (JSON.parse(raw) as CallState) : null;
  }

  async getMany(callIds: string[]): Promise<CallState[]> {
    if (!callIds.length) return [];
    const raws = await this.redis.mget(callIds.map(keyFor));
    return raws
      .filter((r): r is string => !!r)
      .map(r => JSON.parse(r) as CallState);
  }

  async save(state: CallState): Promise<void> {
    await this.redis.set(
      keyFor(state.callId),
      JSON.stringify(state),
      "EX",
      CALL_TTL_SEC,
    );
  }

  /** The live call in a chat (DM or group), if any. */
  async getActiveCallIdForChannel(channelId: string): Promise<string | null> {
    return this.redis.get(channelKeyFor(channelId));
  }

  /** Kept for callers/tests written against the original private-only pointer. */
  async getActivePrivateCallIdForChannel(
    channelId: string,
  ): Promise<string | null> {
    return this.getActiveCallIdForChannel(channelId);
  }

  /** The live calls for many chats at once (chat list): channelId → state. */
  async getActiveCallsForChannels(
    channelIds: string[],
  ): Promise<Map<string, CallState>> {
    const out = new Map<string, CallState>();
    if (!channelIds.length) return out;
    const ids = await this.redis.mget(channelIds.map(channelKeyFor));
    const callIds = ids.filter((id): id is string => !!id);
    for (const state of await this.getMany(callIds)) {
      out.set(state.channelId, state);
    }
    return out;
  }

  /** Call ids currently ringing `userId` (may include stale ids — callers re-check state). */
  async ringingCallIdsFor(userId: string): Promise<string[]> {
    return this.redis.smembers(ringingKeyFor(userId));
  }

  async stopRinging(userIds: string[], callId: string): Promise<void> {
    if (!userIds.length) return;
    const multi = this.redis.multi();
    for (const userId of userIds) multi.srem(ringingKeyFor(userId), callId);
    await multi.exec();
  }

  async activeCallIds(): Promise<string[]> {
    return this.redis.smembers(ACTIVE_SET);
  }

  /** True exactly once per call — whoever gets it writes the call log and cleans up. */
  async acquireFinalize(callId: string): Promise<boolean> {
    const res = await this.redis.set(
      finalizeKeyFor(callId),
      "1",
      "EX",
      300,
      "NX",
    );
    return res === "OK";
  }

  async delete(
    callId: string,
    channelId: string,
    _isPrivate?: boolean,
    ringingUserIds: string[] = [],
  ): Promise<void> {
    const multi = this.redis
      .multi()
      .del(keyFor(callId))
      .srem(ACTIVE_SET, callId);
    for (const userId of ringingUserIds) {
      multi.srem(ringingKeyFor(userId), callId);
    }
    await multi.exec();
    // Only release the chat's slot if it still points at this call.
    const current = await this.redis.get(channelKeyFor(channelId));
    if (current === callId) await this.redis.del(channelKeyFor(channelId));
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
