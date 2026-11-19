import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Interval } from "@nestjs/schedule";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Model, Types } from "mongoose";
import { randomUUID } from "crypto";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { User } from "src/user/schema/user.schema";
import { Block } from "src/user/schema/block.schema";
import { ChatType, MessageType } from "src/enum/base.enum";
import { effectivePermissions } from "src/chat/permissions";
import { CallStateService, CallState } from "./call-state.service";
import { LiveKitTokenService } from "./livekit-token.service";
import { MessageService } from "src/message/message.service";
import {
  CallRingingPayload,
  ChatGateway,
  GroupCallParticipant,
} from "src/gateway/chat.gateway";
import { PrivacyService, idString } from "src/privacy/privacy.service";
import {
  CALL_RING_STOPPED,
  CALL_RINGING,
  CallRingStoppedEvent,
  CallRingingEvent,
} from "src/events/domain-events";

const MAX_GROUP_CALL_PARTICIPANTS = 16; // plan: "SFU handles far more than mesh but set a sane cap"
/** An unanswered DM call gives up after this long and becomes a "missed call". */
export const RING_TIMEOUT_MS = 45_000;
/** Someone who got a room token but isn't in the LiveKit room yet is left alone this long
 *  (their client may still be connecting) before reconciliation drops them. */
const JOIN_GRACE_MS = 45_000;
/** A participant must be missing from LiveKit on this many consecutive sweeps before they're
 *  dropped — a reconnecting client briefly disappears from the room. */
const MISSING_STRIKES = 2;

export interface JoinCallResult {
  callId: string;
  roomName: string;
  roomToken: string;
  livekitUrl: string;
}

export interface GroupCallSummary {
  callId: string;
  channelId: string;
  startedAt: number | null;
  participants: GroupCallParticipant[];
}

type CallLogKind = "missed" | "declined" | "ended";

@Injectable()
export class CallsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallsService.name);
  /** Per-process ring timers (fast path); the periodic sweep covers a restart. */
  private readonly ringTimers = new Map<string, NodeJS.Timeout>();
  private readonly missingStrikes = new Map<string, number>();

  constructor(
    @InjectModel(ChatMembers.name)
    private readonly chatMembersModel: Model<ChatMembers>,
    @InjectModel(Chat.name) private readonly chatModel: Model<Chat>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Block.name) private readonly blockModel: Model<Block>,
    private readonly callState: CallStateService,
    private readonly liveKitToken: LiveKitTokenService,
    private readonly messageService: MessageService,
    private readonly chatGateway: ChatGateway,
    private readonly privacy: PrivacyService,
    private readonly events?: EventEmitter2,
  ) {}

  onModuleInit(): void {
    // A socket that connects (or reconnects) after a ring went out still rings.
    this.chatGateway.onUserConnected(async (userId, socketId) => {
      for (const ring of await this.pendingIncomingCalls(userId)) {
        this.chatGateway.notifyCallRinging(userId, ring, socketId);
      }
    });
  }

  onModuleDestroy(): void {
    for (const t of this.ringTimers.values()) clearTimeout(t);
    this.ringTimers.clear();
  }

  private displayName(user: {
    firstName?: string;
    lastName?: string;
    username?: string;
  }): string {
    const parts = [user.firstName, user.lastName].filter(Boolean);
    const full = parts.join(" ").trim();
    return full || user.username || "Someone";
  }

  /** LiveKit participant metadata (a JSON string every other participant can read) — lets the
   *  call screen show each person's profile photo on their tile without another API round trip.
   *  The photo is included only if everyone who can read it may see it: in a private call the
   *  other member (their profile-photo privacy decides); in a group call, only a photo anyone
   *  may see. */
  private async participantMetadata(
    user: { _id?: unknown; image?: string[] } | null | undefined,
    state: { channelId: string; isPrivate: boolean },
  ): Promise<string> {
    const photo = user?.image?.[0] || null;
    if (!photo || !user?._id) return JSON.stringify({ photo: null });
    const ownerId = idString(user._id);
    const audience = await this.privacy.audienceOf(ownerId, "profilePhotos");
    let visible = audience.everyone;
    if (!visible && state.isPrivate) {
      const other = await this.chatMembersModel
        .findOne({ channelId: state.channelId, userId: { $ne: ownerId } })
        .select("userId")
        .lean()
        .exec();
      visible = !!other && audience.allows(other.userId);
    }
    return JSON.stringify({ photo: visible ? photo : null });
  }

  private async isBlockedEitherWay(
    userIdA: string,
    userIdB: string,
  ): Promise<boolean> {
    const block = await this.blockModel
      .findOne({
        $or: [
          {
            blockerId: new Types.ObjectId(userIdA),
            blockedId: new Types.ObjectId(userIdB),
          },
          {
            blockerId: new Types.ObjectId(userIdB),
            blockedId: new Types.ObjectId(userIdA),
          },
        ],
      })
      .lean()
      .exec();
    return !!block;
  }

  private async userFor(userId: string) {
    return this.userModel
      .findById(userId)
      .select("username firstName lastName image")
      .lean()
      .exec();
  }

  private ringPayload(state: CallState): CallRingingPayload {
    return {
      callId: state.callId,
      channelId: state.channelId,
      fromUserId: state.initiatorId,
      fromUsername: state.initiatorName ?? "Someone",
      isPrivate: state.isPrivate,
      expiresAt: state.ringExpiresAt ?? undefined,
    };
  }

  /** Claims the chat's live-call slot; a pointer left behind by a call whose state is gone
   *  (TTL, crash mid-cleanup) is released and retried once instead of blocking calls forever. */
  private async claimChannel(
    channelId: string,
    callId: string,
  ): Promise<{ ok: true } | { ok: false; existing: string }> {
    if (await this.callState.claimChannel(channelId, callId))
      return { ok: true };
    const existing = await this.callState.getActiveCallIdForChannel(channelId);
    if (existing && !(await this.callState.get(existing))) {
      await this.callState.delete(existing, channelId);
      if (await this.callState.claimChannel(channelId, callId)) {
        return { ok: true };
      }
    }
    const now = await this.callState.getActiveCallIdForChannel(channelId);
    return { ok: false, existing: now ?? existing ?? "" };
  }

  async createCall(
    channelId: string,
    callerId: string,
  ): Promise<JoinCallResult> {
    const membership = await this.chatMembersModel
      .findOne({ channelId, userId: callerId, isBanned: { $ne: true } })
      .lean()
      .exec();
    if (!membership) {
      throw new ForbiddenException("Access denied");
    }
    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .select("type defaultPermissions")
      .lean()
      .exec();
    if (!chat) {
      throw new NotFoundException("Channel not found");
    }
    const isPrivate = chat.type === ChatType.PRIVATE;
    if (chat.type === ChatType.SAVED_MESSAGES) {
      throw new BadRequestException("You can't call here");
    }
    if (!isPrivate) {
      return this.startOrJoinGroupCall(channelId, callerId, chat, membership);
    }

    const otherMembers = await this.chatMembersModel
      .find({
        channelId,
        userId: { $ne: callerId },
        isBanned: { $ne: true },
      })
      .select("userId")
      .lean()
      .exec();
    const other = otherMembers[0];
    if (other && (await this.isBlockedEitherWay(callerId, other.userId))) {
      throw new ForbiddenException("You can't call this user");
    }
    // "Calls" privacy (Telegram): the callee decides who may call them.
    if (
      other &&
      !(await this.privacy.allows(other.userId, callerId, "calls"))
    ) {
      const callee = await this.userModel
        .findById(other.userId)
        .select("username firstName lastName")
        .lean()
        .exec();
      throw new ForbiddenException({
        statusCode: 403,
        error: "Forbidden",
        code: "privacy_calls",
        message: `${callee ? this.displayName(callee) : "This user"} doesn't accept calls from you`,
      });
    }

    const callId = randomUUID();
    const claim = await this.claimChannel(channelId, callId);
    if (!claim.ok) {
      throw new BadRequestException("A call is already in progress");
    }

    const caller = await this.userFor(callerId);
    const callerName = caller ? this.displayName(caller) : "Someone";
    const now = Date.now();
    // Ring the other member even if they "deleted" the DM on their side (isJoined false) —
    // the old `isJoined: true` filter silently skipped them, so the call never rang.
    const calleeIds = other ? [String(other.userId)] : [];
    const state: CallState = {
      callId,
      channelId,
      isPrivate: true,
      initiatorId: callerId,
      // The caller is a participant from the moment they get a room token — `joinCall`'s
      // "answered" check is `participantIds.length >= 2`.
      participantIds: [callerId],
      startedAt: null,
      createdAt: now,
      roomName: `call-${callId}`,
      ringingUserIds: calleeIds,
      ringExpiresAt: now + RING_TIMEOUT_MS,
      joinedAt: { [callerId]: now },
      initiatorName: callerName,
    };
    await this.callState.create(state);

    const roomToken = await this.liveKitToken.createRoomToken(
      state.roomName,
      callerId,
      callerName,
      await this.participantMetadata(caller, { channelId, isPrivate: true }),
    );

    const ring = this.ringPayload(state);
    for (const calleeId of calleeIds) {
      this.chatGateway.notifyCallRinging(calleeId, ring);
    }
    if (calleeIds.length) {
      this.events?.emit(CALL_RINGING, {
        callId,
        channelId,
        callerId,
        callerName,
        calleeIds,
        expiresAt: state.ringExpiresAt!,
      } satisfies CallRingingEvent);
    }
    this.scheduleRingTimeout(callId, RING_TIMEOUT_MS);

    return {
      callId,
      roomName: state.roomName,
      roomToken,
      livekitUrl: this.liveKitToken.livekitUrl,
    };
  }

  /** Groups and channels (Telegram voice chats): one live call per chat that members join
   *  and leave freely. Starting one doesn't ring anyone — it posts "X started a voice chat"
   *  (a normal message notification) and shows a bar in the chat. Starting when one is
   *  already running just joins it. */
  private async startOrJoinGroupCall(
    channelId: string,
    callerId: string,
    chat: { type: ChatType; defaultPermissions?: unknown },
    membership: ChatMembers,
  ): Promise<JoinCallResult> {
    if (membership.isJoined === false) {
      throw new ForbiddenException("Access denied");
    }
    const existing = await this.callState.getActiveCallIdForChannel(channelId);
    if (existing && (await this.callState.get(existing))) {
      return this.joinCall(existing, callerId);
    }
    // Starting needs the right to post (channels: admins; groups: members who may write).
    if (!effectivePermissions(chat, membership).canPost) {
      throw new ForbiddenException(
        chat.type === ChatType.CHANNEL
          ? "Only admins can start a voice chat in this channel"
          : "You can't start a voice chat here",
      );
    }

    const callId = randomUUID();
    const claim = await this.claimChannel(channelId, callId);
    if (!claim.ok) {
      // Someone else started it a moment ago — join theirs.
      if (claim.existing) return this.joinCall(claim.existing, callerId);
      throw new BadRequestException("A call is already in progress");
    }

    const caller = await this.userFor(callerId);
    const callerName = caller ? this.displayName(caller) : "Someone";
    const now = Date.now();
    const state: CallState = {
      callId,
      channelId,
      isPrivate: false,
      initiatorId: callerId,
      participantIds: [callerId],
      startedAt: now,
      createdAt: now,
      roomName: `call-${callId}`,
      ringingUserIds: [],
      ringExpiresAt: null,
      joinedAt: { [callerId]: now },
      initiatorName: callerName,
    };
    await this.callState.create(state);

    const roomToken = await this.liveKitToken.createRoomToken(
      state.roomName,
      callerId,
      callerName,
      await this.participantMetadata(caller, { channelId, isPrivate: false }),
    );

    await this.postServiceMessage(channelId, [callerId], "voice_chat_started", {
      senderName: callerName,
      callId,
    });
    await this.broadcastGroupCall(state);

    return {
      callId,
      roomName: state.roomName,
      roomToken,
      livekitUrl: this.liveKitToken.livekitUrl,
    };
  }

  async joinCall(callId: string, userId: string): Promise<JoinCallResult> {
    const state = await this.callState.get(callId);
    if (!state) {
      throw new NotFoundException("Call not found or already ended");
    }
    const membership = await this.chatMembersModel
      .findOne({
        channelId: state.channelId,
        userId,
        isBanned: { $ne: true },
      })
      .lean()
      .exec();
    if (!membership || (!state.isPrivate && membership.isJoined === false)) {
      throw new ForbiddenException("Access denied");
    }

    const alreadyIn = state.participantIds.includes(userId);
    if (
      !alreadyIn &&
      !state.isPrivate &&
      state.participantIds.length >= MAX_GROUP_CALL_PARTICIPANTS
    ) {
      throw new BadRequestException(
        `This call is full (max ${MAX_GROUP_CALL_PARTICIPANTS} participants)`,
      );
    }

    const wasRinging = (state.ringingUserIds ?? []).includes(userId);
    if (!alreadyIn) state.participantIds.push(userId);
    state.joinedAt = { ...(state.joinedAt ?? {}), [userId]: Date.now() };
    this.missingStrikes.delete(`${callId}:${userId}`);
    // "Answered" the moment a second distinct participant actually joins.
    if (state.startedAt == null && state.participantIds.length >= 2) {
      state.startedAt = Date.now();
    }
    if (wasRinging) {
      state.ringingUserIds = (state.ringingUserIds ?? []).filter(
        id => id !== userId,
      );
    }
    await this.callState.save(state);

    if (wasRinging) {
      await this.callState.stopRinging([userId], callId);
      this.clearRingTimer(callId);
      // Other tabs/devices of the callee stop ringing.
      this.chatGateway.notifyCallHandled(userId, {
        callId,
        channelId: state.channelId,
        action: "answered",
      });
      this.events?.emit(CALL_RING_STOPPED, {
        callId,
        channelId: state.channelId,
        userIds: [userId],
        reason: "answered",
      } satisfies CallRingStoppedEvent);
    }
    if (!state.isPrivate && !alreadyIn) await this.broadcastGroupCall(state);

    const user = await this.userFor(userId);
    const name = user ? this.displayName(user) : "Someone";
    const roomToken = await this.liveKitToken.createRoomToken(
      state.roomName,
      userId,
      name,
      await this.participantMetadata(user, state),
    );

    return {
      callId,
      roomName: state.roomName,
      roomToken,
      livekitUrl: this.liveKitToken.livekitUrl,
    };
  }

  async leaveCall(
    callId: string,
    userId: string,
  ): Promise<{ success: boolean }> {
    const state = await this.callState.get(callId);
    if (!state) return { success: true }; // already ended — leaving is a no-op, not an error
    if (!state.participantIds.includes(userId) && !state.isPrivate) {
      return { success: true };
    }

    state.participantIds = state.participantIds.filter(id => id !== userId);

    // A private call always ends the moment either side leaves (the caller hanging up
    // before an answer is a cancel → "missed"). A group call only ends once everyone left.
    if (state.isPrivate || state.participantIds.length === 0) {
      await this.finalizeCall(state);
    } else {
      await this.callState.save(state);
      await this.broadcastGroupCall(state);
    }
    return { success: true };
  }

  /** Private calls only — the callee explicitly rejects before ever joining. */
  async declineCall(
    callId: string,
    userId: string,
  ): Promise<{ success: boolean }> {
    const state = await this.callState.get(callId);
    if (!state) return { success: true };
    if (!state.isPrivate) {
      throw new BadRequestException("Only private calls can be declined");
    }
    const membership = await this.chatMembersModel
      .findOne({ channelId: state.channelId, userId })
      .lean()
      .exec();
    if (!membership) {
      throw new ForbiddenException("Access denied");
    }
    this.chatGateway.notifyCallHandled(userId, {
      callId,
      channelId: state.channelId,
      action: "declined",
    });
    await this.finalizeCall(state, "declined");
    return { success: true };
  }

  /** Calls ringing `userId` right now — what a socket that just (re)connected, or an app
   *  opened from a call notification, should be ringing for. Expired rings are finalized
   *  "missed" on the way (covers a ring timer lost to a restart). */
  async pendingIncomingCalls(userId: string): Promise<CallRingingPayload[]> {
    const ids = await this.callState.ringingCallIdsFor(userId);
    if (!ids.length) return [];
    const states = await this.callState.getMany(ids);
    const live = new Set(states.map(s => s.callId));
    const stale = ids.filter(id => !live.has(id));
    const now = Date.now();
    const out: CallRingingPayload[] = [];
    for (const state of states) {
      const ringing =
        state.isPrivate &&
        state.startedAt == null &&
        (state.ringingUserIds ?? []).includes(userId);
      if (!ringing) {
        stale.push(state.callId);
        continue;
      }
      if ((state.ringExpiresAt ?? 0) <= now) {
        await this.finalizeCall(state, "missed");
        continue;
      }
      out.push(this.ringPayload(state));
    }
    if (stale.length) {
      for (const id of stale) await this.callState.stopRinging([userId], id);
    }
    return out;
  }

  /** The live group voice chat in a chat (top bar on open), or null. */
  async activeGroupCall(
    channelId: string,
    userId: string,
  ): Promise<GroupCallSummary | null> {
    const membership = await this.chatMembersModel
      .findOne({ channelId, userId, isBanned: { $ne: true } })
      .select("_id")
      .lean()
      .exec();
    if (!membership) throw new ForbiddenException("Access denied");
    const callId = await this.callState.getActiveCallIdForChannel(channelId);
    if (!callId) return null;
    const state = await this.callState.get(callId);
    if (!state || state.isPrivate) return null;
    return {
      callId,
      channelId,
      startedAt: state.startedAt,
      participants: await this.roster(state),
    };
  }

  /** Who's in a group call, as everyone in the chat may see them (one shared roster, so
   *  only a photo anyone may see). */
  private async roster(state: CallState): Promise<GroupCallParticipant[]> {
    if (!state.participantIds.length) return [];
    const users = await this.userModel
      .find({
        _id: {
          $in: state.participantIds
            .filter(id => Types.ObjectId.isValid(id))
            .map(id => new Types.ObjectId(id)),
        },
      })
      .select("username firstName lastName image")
      .lean()
      .exec();
    const byId = new Map(users.map(u => [String(u._id), u]));
    return Promise.all(
      state.participantIds.map(async id => {
        const u = byId.get(id);
        const photo = u?.image?.[0] || null;
        let visible = false;
        if (photo) {
          visible = (await this.privacy.audienceOf(id, "profilePhotos"))
            .everyone;
        }
        return {
          _id: id,
          name: u ? this.displayName(u) : "Someone",
          photo: visible ? photo : null,
        };
      }),
    );
  }

  private async broadcastGroupCall(state: CallState): Promise<void> {
    try {
      this.chatGateway.notifyGroupCallUpdated(state.channelId, {
        callId: state.callId,
        startedAt: state.startedAt,
        participants: await this.roster(state),
      });
    } catch (err) {
      this.logger.warn(`group call broadcast failed: ${String(err)}`);
    }
  }

  /** Posts a server-authored service message as the first of `senderIds` still allowed to
   *  post (whoever started a call may have left the group by the time it ends). */
  private async postServiceMessage(
    channelId: string,
    senderIds: string[],
    content: string,
    metadata: Record<string, unknown>,
    type: MessageType = MessageType.SYSTEM,
  ): Promise<void> {
    // In a channel a voice chat is the channel's ("X started" names the channel, not the admin
    // who pressed the button — subscribers never see who posts).
    const chat = await this.chatModel
      .findById(channelId)
      .select("type name")
      .lean()
      .exec();
    if (chat?.type === ChatType.CHANNEL) {
      metadata = { ...metadata, senderName: chat.name };
    }
    for (const senderId of [...new Set(senderIds)]) {
      try {
        const message = await this.messageService.create(
          { channelId, content, type },
          senderId,
          { metadata },
        );
        this.chatGateway.broadcastNewMessage(channelId, message);
        return;
      } catch {
        // Try the next candidate — a logging failure must never leave call state stuck.
      }
    }
  }

  private scheduleRingTimeout(callId: string, ms: number): void {
    this.clearRingTimer(callId);
    const timer = setTimeout(() => {
      this.ringTimers.delete(callId);
      void this.expireRing(callId).catch(err =>
        this.logger.warn(`ring timeout failed: ${String(err)}`),
      );
    }, ms);
    timer.unref?.();
    this.ringTimers.set(callId, timer);
  }

  private clearRingTimer(callId: string): void {
    const t = this.ringTimers.get(callId);
    if (t) clearTimeout(t);
    this.ringTimers.delete(callId);
  }

  /** The ring ran out: an unanswered DM call becomes a missed call (the caller's screen and
   *  the callee's ring both stop via `call:ended`). */
  async expireRing(callId: string): Promise<void> {
    const state = await this.callState.get(callId);
    if (!state || !state.isPrivate || state.startedAt != null) return;
    await this.finalizeCall(state, "missed");
  }

  /**
   * Every 10 s: ring timeouts a restart lost, and calls whose people are gone from LiveKit
   * (a crashed client never calls /leave). Group participants missing from the room are
   * dropped (the bar updates); a call nobody is in any more ends.
   */
  @Interval(10_000)
  async sweep(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.callState.activeCallIds();
    } catch {
      return; // Redis down — try again next tick.
    }
    if (!ids.length) return;
    const states = await this.callState.getMany(ids);
    const live = new Set(states.map(s => s.callId));
    for (const id of ids) {
      if (!live.has(id)) await this.callState.delete(id, "").catch(() => {});
    }
    const now = Date.now();
    for (const state of states) {
      try {
        if (state.isPrivate && state.startedAt == null) {
          if (
            (state.ringExpiresAt ?? state.createdAt + RING_TIMEOUT_MS) <= now
          ) {
            await this.finalizeCall(state, "missed");
          }
          continue;
        }
        await this.reconcile(state, now);
      } catch (err) {
        this.logger.warn(
          `call sweep failed for ${state.callId}: ${String(err)}`,
        );
      }
    }
  }

  async reconcile(state: CallState, now = Date.now()): Promise<void> {
    const present = await this.liveKitToken.listParticipantIdentities(
      state.roomName,
    );
    if (present == null) return; // LiveKit can't be asked — leave state alone.
    const inRoom = new Set(present);
    const gone: string[] = [];
    for (const id of state.participantIds) {
      const key = `${state.callId}:${id}`;
      const joined = state.joinedAt?.[id] ?? state.createdAt;
      if (inRoom.has(id) || now - joined < JOIN_GRACE_MS) {
        this.missingStrikes.delete(key);
        continue;
      }
      const strikes = (this.missingStrikes.get(key) ?? 0) + 1;
      this.missingStrikes.set(key, strikes);
      if (strikes >= MISSING_STRIKES) gone.push(id);
    }
    if (!gone.length) return;
    for (const id of gone) this.missingStrikes.delete(`${state.callId}:${id}`);
    const fresh = await this.callState.get(state.callId);
    if (!fresh) return;
    fresh.participantIds = fresh.participantIds.filter(
      id => !gone.includes(id),
    );
    if (fresh.isPrivate || fresh.participantIds.length === 0) {
      await this.finalizeCall(fresh);
    } else {
      await this.callState.save(fresh);
      await this.broadcastGroupCall(fresh);
    }
  }

  /**
   * Ends a call exactly once (a Redis lock — a hang-up racing a decline, the ring timeout or
   * another instance's sweep can't write two call logs). DM calls write one call-log message
   * describing the whole call; group voice chats post "Voice chat ended · N min".
   */
  private async finalizeCall(
    state: CallState,
    forcedKind?: CallLogKind,
  ): Promise<void> {
    if (!(await this.callState.acquireFinalize(state.callId))) return;
    this.clearRingTimer(state.callId);
    const kind: CallLogKind =
      forcedKind ?? (state.startedAt != null ? "ended" : "missed");
    const ringing = state.ringingUserIds ?? [];

    // Clear state first, so a reconnecting socket can't be re-rung for a call that's over.
    await this.callState.delete(
      state.callId,
      state.channelId,
      state.isPrivate,
      ringing,
    );

    if (state.isPrivate) {
      const durationMinutes =
        kind === "ended" && state.startedAt != null
          ? Math.max(1, Math.round((Date.now() - state.startedAt) / 60_000))
          : undefined;
      await this.postServiceMessage(
        state.channelId,
        [state.initiatorId],
        JSON.stringify({
          callLog: true,
          kind,
          ...(durationMinutes != null ? { durationMinutes } : {}),
        }),
        {},
        MessageType.VOICE_CALL,
      );
    } else {
      const minutes = Math.max(
        1,
        Math.round(
          (Date.now() - (state.startedAt ?? state.createdAt)) / 60_000,
        ),
      );
      await this.postServiceMessage(
        state.channelId,
        [state.initiatorId, ...state.participantIds],
        "voice_chat_ended",
        {
          senderName: state.initiatorName ?? "Someone",
          callId: state.callId,
          durationMinutes: minutes,
        },
      );
      this.chatGateway.notifyGroupCallUpdated(state.channelId, {
        callId: null,
        startedAt: null,
        participants: [],
      });
    }

    const memberIds = state.isPrivate
      ? (
          await this.chatMembersModel
            .find({ channelId: state.channelId })
            .select("userId")
            .lean()
            .exec()
        ).map(m => String(m.userId))
      : [];
    this.chatGateway.notifyCallEnded(
      state.channelId,
      { callId: state.callId, kind },
      memberIds,
    );

    if (ringing.length) {
      this.events?.emit(CALL_RING_STOPPED, {
        callId: state.callId,
        channelId: state.channelId,
        userIds: ringing,
        reason: kind === "declined" ? "declined" : "missed",
      } satisfies CallRingStoppedEvent);
    }

    if (kind === "missed" && state.isPrivate) {
      for (const id of memberIds.filter(id => id !== state.initiatorId)) {
        this.chatGateway.notifyCallMissed(id, {
          callId: state.callId,
          channelId: state.channelId,
        });
      }
    }
  }
}
