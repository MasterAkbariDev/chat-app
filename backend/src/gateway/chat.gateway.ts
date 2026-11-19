import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { Namespace, Server, Socket } from "socket.io";
import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { JWTPayload } from "src/interface/base.interface";
import { ChatType, UserStatus } from "src/enum/base.enum";
import { MessageService } from "src/message/message.service";
import { CreateMessageDto } from "src/message/dto/create-message.dto";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { User } from "src/user/schema/user.schema";
import { Message } from "src/message/schema/message.schema";
import { UserService } from "src/user/user.service";
import { AuthService } from "src/auth/auth.service";
import { PresenceService } from "src/presence/presence.service";
import { PrivacyService, idString } from "src/privacy/privacy.service";
import { parseCorsAllowlist } from "src/common/cors-allowlist";
import { Logger } from "nestjs-pino";
import { randomUUID } from "crypto";

export interface CallRingingPayload {
  callId: string;
  channelId: string;
  fromUserId: string;
  fromUsername: string;
  isPrivate: boolean;
  /** Epoch ms when the ring gives up — a client never rings past it, even if it misses
   *  the `call:ended` that normally stops it. */
  expiresAt?: number;
}

export interface GroupCallParticipant {
  _id: string;
  name: string;
  /** Only a photo anyone may see (everyone in the chat gets the same roster). */
  photo: string | null;
}

interface SocketAuth extends Socket {
  userId?: string;
  /** The session family of the access token this connection was made with (see auth.session_revoked). */
  sessionId?: string;
  userEmail?: string;
  username?: string;
  /** Threads a correlation id through this connection's log lines (B11) — generated fresh per
   *  connection rather than reused from any HTTP request, since a socket isn't tied to one. */
  correlationId?: string;
}

@WebSocketGateway({
  // Same allowlist as the HTTP server — no wildcard fallback (parseCorsAllowlist throws
  // at boot if CORS_ORIGIN is unset, same fail-closed behavior as main.ts).
  cors: {
    origin: parseCorsAllowlist(process.env.CORS_ORIGIN),
    credentials: true,
  },
  namespace: "/",
})
@Injectable()
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private userSockets = new Map<string, Set<string>>();
  private socketUsers = new Map<string, string>();
  private userStatuses = new Map<string, UserStatus>();
  /** Keeps the Redis `presence:<uid>` TTL alive while at least one socket is open. */
  private presenceHeartbeats = new Map<string, NodeJS.Timeout>();
  private static readonly PRESENCE_HEARTBEAT_MS = 15_000;
  private typingUsers = new Map<string, Map<string, NodeJS.Timeout>>();
  private uploadingUsers = new Map<string, Set<string>>();

  /**
   * Minimal per-socket token bucket for `send_message` (20/10s), so one client can't
   * flood a room. This is a stopgap for B0 — the full realtime rework (one write path,
   * per-socket limits on every event) is B3.
   */
  private static readonly SEND_MESSAGE_LIMIT = 20;
  private static readonly SEND_MESSAGE_WINDOW_MS = 10_000;
  private sendMessageBuckets = new Map<
    string,
    { count: number; resetAt: number }
  >();

  private isSendMessageRateLimited(socketId: string): boolean {
    const now = Date.now();
    const bucket = this.sendMessageBuckets.get(socketId);
    if (!bucket || bucket.resetAt <= now) {
      this.sendMessageBuckets.set(socketId, {
        count: 1,
        resetAt: now + ChatGateway.SEND_MESSAGE_WINDOW_MS,
      });
      return false;
    }
    bucket.count += 1;
    return bucket.count > ChatGateway.SEND_MESSAGE_LIMIT;
  }

  // Voice/video calls moved to LiveKit (SFU) + coturn (TURN) in B8 (docs/plans/BACKEND_PLAN.md)
  // — see src/calls/. This gateway previously held the entire call system as in-process state
  // (`activeCalls`/`privateCallByChannel` Maps) plus 10 mesh WebRTC signaling handlers
  // (call_request/accept/decline/create/join/leave/signal/health_check/mute/cancel); none of
  // that survived a restart or worked across more than one server instance. All of it is
  // removed — this gateway now only carries the 3 call *notification* events the plan calls
  // for (`notifyCallRinging`/`notifyCallEnded`/`notifyCallMissed`, below). Media, participant
  // roster, and mute state all come from the LiveKit client SDK directly.

  private static readonly CHAT_NAMESPACE = "/";

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private messageService: MessageService,
    private userService: UserService,
    private authService: AuthService,
    @InjectModel(ChatMembers.name)
    private chatMembersModel: Model<ChatMembers>,
    @InjectModel(Chat.name) private chatModel: Model<Chat>,
    @InjectModel(User.name) private userModel: Model<User>,
    private presenceService: PresenceService,
    private logger: Logger,
    private privacy: PrivacyService,
  ) {}

  /** Emit an event to all sockets of a user (e.g. "user_unblocked_you" after unblock). */
  emitToUser(userId: string, event: string, payload: object): void {
    const ns = this.getChatNamespace();
    ns.to(`user:${userId}`).emit(event, payload);
  }

  /** Notify all members of a channel that the admins list / roles changed. */
  notifyChannelRolesUpdated(channelId: string, admins: Types.ObjectId[]): void {
    const ns = this.getChatNamespace();
    const adminIds = admins.map(id => id.toString());
    ns.to(`channel:${channelId}`).emit("channel_roles_updated", {
      channelId,
      admins: adminIds,
    });
  }

  /** Admin rights or member permissions changed. Everyone in the chat refetches their
   *  own rights (`GET /chats/:id/permissions`); `userId` is set when only one person's
   *  exceptions changed. */
  notifyPermissionsUpdated(channelId: string, userId?: string): void {
    this.getChatNamespace()
      .to(`channel:${channelId}`)
      .emit("chat_permissions_updated", {
        channelId,
        ...(userId ? { userId } : {}),
      });
  }

  /** A group/channel's details changed (name, description, photo, visibility,
   *  link) — members refresh their chat list and open chat header. */
  notifyChatUpdated(
    channelId: string,
    chat: {
      name: string;
      description: string | null;
      image: string[];
      isPublic: boolean;
      link: string;
      signature?: boolean;
    },
  ): void {
    this.getChatNamespace()
      .to(`channel:${channelId}`)
      .emit("chat_updated", { channelId, ...chat });
  }

  /** Notify a user that they were banned from a channel/group. */
  notifyChatBanned(channelId: string, userId: string): void {
    this.emitToUser(userId, "chat_banned", { channelId });
  }

  /** Notify a user they were muted/unmuted in a group (real-time composer update). */
  notifyUserMuted(channelId: string, userId: string, muted: boolean): void {
    this.emitToUser(userId, "user_muted", { channelId, muted });
  }

  /** Broadcast a persisted message to channel members (REST-created messages). */
  broadcastNewMessage(
    channelId: string,
    message: Record<string, unknown>,
  ): void {
    void this.emitMessageEvent(`channel:${channelId}`, "new_message", {
      message,
      channelId,
    });
  }

  /** Notify all members of a channel that a message was edited (real-time update). */
  notifyMessageUpdated(
    channelId: string,
    message: Record<string, unknown>,
  ): void {
    void this.emitMessageEvent(`channel:${channelId}`, "message_updated", {
      channelId,
      message,
    });
  }

  /**
   * Emits a message event to a chat room. When the sender's profile-photo privacy doesn't
   * let everyone see their photo, each member gets the payload with or without it — so the
   * photo never reaches someone it's hidden from. `canReceive` filters recipients (blocks).
   */
  private async emitMessageEvent(
    room: string,
    event: string,
    payload: { message: unknown } & Record<string, unknown>,
    canReceive?: (userId: string) => Promise<boolean>,
  ): Promise<void> {
    try {
      const message = payload.message as {
        senderId?: unknown;
        channelId?: unknown;
      } | null;
      const sender =
        message?.senderId && typeof message.senderId === "object"
          ? (message.senderId as {
              _id?: unknown;
              avatarUrl?: string[];
              avatarVideoUrl?: string;
            })
          : null;
      let everyone = true;
      let allows: (uid: string) => boolean = () => true;
      // A channel post's "sender" is the channel (channel-author.util.ts): its photo is the
      // channel's, not a person's, so no profile-photo privacy applies to it.
      const channelPost =
        !!message?.channelId &&
        !!sender?._id &&
        typeof message.channelId === "string" &&
        idString(sender._id) === message.channelId;
      if (sender?._id && sender.avatarUrl?.length && !channelPost) {
        const audience = await this.privacy.audienceOf(
          idString(sender._id),
          "profilePhotos",
        );
        everyone = audience.everyone;
        allows = audience.allows;
      }
      if (everyone && !canReceive) {
        this.server.in(room).emit(event, payload);
        return;
      }
      const stripped = sender
        ? {
            ...payload,
            message: {
              ...(message as object),
              senderId: { ...sender, avatarUrl: [], avatarVideoUrl: undefined },
            },
          }
        : payload;
      const roomSet = this.getChatNamespace().adapter.rooms.get(room);
      if (!roomSet) return;
      for (const socketId of [...roomSet]) {
        const uid = this.socketUsers.get(socketId);
        if (!uid) continue;
        if (canReceive && !(await canReceive(uid))) continue;
        this.server.to(socketId).emit(event, allows(uid) ? payload : stripped);
      }
    } catch (error) {
      const errLog: { err: unknown } = { err: error };
      this.logger.error(errLog, "message broadcast failed");
    }
  }

  /** Notify all members of a channel that a message was deleted for everyone (real-time). */
  notifyMessageDeleted(
    channelId: string,
    messageId: string,
    /** The recomputed chat-list summary, so lists update in place (no refetch). */
    state?: { lastMessageAt: Date | null; lastMessagePreview: string | null },
  ): void {
    this.server.to(`channel:${channelId}`).emit("message_deleted", {
      channelId,
      messageId,
      ...(state
        ? {
            lastMessageAt: state.lastMessageAt?.toISOString?.() ?? null,
            lastMessagePreview: state.lastMessagePreview,
          }
        : {}),
    });
  }

  /**
   * Reaction toggle delta (B5) — a small payload (no full reactions map) so a busy message
   * doesn't cost every viewer a large re-render on each toggle. Exactly one of `emoji`/
   * `packItemId` is set, matching the reaction itself. `relativePath`/`packId` are only
   * populated for `action: "added"` (a client removing a reaction it can already render doesn't
   * need to re-resolve its media) — null on `"removed"`.
   */
  notifyReactionChanged(
    channelId: string,
    payload: {
      messageId: string;
      emoji: string | null;
      packItemId: string | null;
      relativePath: string | null;
      packId: string | null;
      userId: string;
      action: "added" | "removed";
    },
  ): void {
    this.server.to(`channel:${channelId}`).emit("reaction_changed", {
      channelId,
      ...payload,
    });
  }

  /** Read-receipt delta (B5) — lets senders update their tick indicators live. */
  notifyReadUpdated(
    channelId: string,
    payload: {
      userId: string;
      lastReadMessageId: string;
      /** createdAt of `lastReadMessageId` (ISO) — everything up to it is read. */
      upToCreatedAt?: string | null;
    },
  ): void {
    this.server.to(`channel:${channelId}`).emit("read:updated", {
      channelId,
      ...payload,
    });
  }

  /**
   * B8 (calls) — rings the callee(s). Targeted at a single user, so `CallsService` calls this
   * once per recipient (the other member for a private call; every other joined member for a
   * group call).
   */
  notifyCallRinging(
    userId: string,
    payload: CallRingingPayload,
    /** Only this socket (a just-connected one catching up on a ring it missed). */
    socketId?: string,
  ): void {
    if (socketId) {
      this.getChatNamespace().to(socketId).emit("call:ringing", payload);
      return;
    }
    this.emitToUser(userId, "call:ringing", payload);
  }

  /** B8 (calls) — the call is over (answered-then-ended, declined, or missed); broadcast to
   *  the whole channel so every client can dismiss any "in call" UI. `userIds` also reach
   *  those people's own rooms — a callee whose socket never joined the chat's room (a DM
   *  created after it connected, a reconnect still re-joining rooms) must still stop ringing. */
  notifyCallEnded(
    channelId: string,
    payload: { callId: string; kind: "missed" | "declined" | "ended" },
    userIds: string[] = [],
  ): void {
    const rooms = [`channel:${channelId}`, ...userIds.map(id => `user:${id}`)];
    this.getChatNamespace()
      .to(rooms)
      .emit("call:ended", { channelId, ...payload });
  }

  /** A ringing call was answered or declined on one of this user's devices — every other
   *  tab/device stops ringing (Telegram: answering on the phone silences the desktop). */
  notifyCallHandled(
    userId: string,
    payload: {
      callId: string;
      channelId: string;
      action: "answered" | "declined";
    },
  ): void {
    this.emitToUser(userId, "call:handled", payload);
  }

  /** Group voice chat roster changed (started, someone joined/left, ended → `callId: null`).
   *  Goes to the chat's room so its top bar and the chat-list indicator update live. */
  notifyGroupCallUpdated(
    channelId: string,
    payload: {
      callId: string | null;
      startedAt: number | null;
      participants: GroupCallParticipant[];
    },
  ): void {
    this.getChatNamespace()
      .to(`channel:${channelId}`)
      .emit("group_call_updated", { channelId, ...payload });
  }

  private connectHooks: ((userId: string, socketId: string) => unknown)[] = [];

  /** Runs after a socket is authenticated and has joined its rooms (CallsService uses it to
   *  re-deliver rings the socket missed). Registered at boot, not injected, so the gateway
   *  doesn't depend on the modules that depend on it. */
  onUserConnected(hook: (userId: string, socketId: string) => unknown): void {
    this.connectHooks.push(hook);
  }

  /** B8 (calls) — targeted at whoever never got to answer, for a "missed call" badge/notification
   *  distinct from the general `call:ended` broadcast above. */
  notifyCallMissed(
    userId: string,
    payload: { callId: string; channelId: string },
  ): void {
    this.emitToUser(userId, "call:missed", payload);
  }

  /**
   * B7 (notifications) — "skip push if the recipient has the channel open." Single-node room
   * membership check via the Socket.IO adapter (this app's actual deployment shape); a true
   * multi-node "who's viewing what" would need a shared store, not attempted here.
   */
  isUserInChannelRoom(userId: string, channelId: string): boolean {
    const roomSet = this.getChatNamespace().adapter.rooms.get(
      `channel:${channelId}`,
    );
    if (!roomSet) return false;
    for (const socketId of roomSet) {
      if (this.socketUsers.get(socketId) === userId) return true;
    }
    return false;
  }

  /**
   * Presence (`user_status_changed`) goes only to people who share a direct chat or group
   * with the user AND may see their last seen — both ways (Telegram's reciprocity: hide yours
   * from someone and you don't see theirs). Everyone else just keeps the approximate
   * "last seen recently / within a week…" they get from `GET /users/:id/status`.
   */
  private async broadcastPresence(
    userId: string,
    payload: { userId: string; status: UserStatus; lastSeen?: string },
  ): Promise<void> {
    const memberships = await this.chatMembersModel
      .find({ userId, isJoined: true, isBanned: { $ne: true } })
      .select("channelId")
      .lean()
      .exec();
    const channelIds = memberships
      .map(m => String(m.channelId))
      .filter(id => Types.ObjectId.isValid(id));
    if (!channelIds.length) return;
    const chats = await this.chatModel
      .find({
        _id: { $in: channelIds.map(id => new Types.ObjectId(id)) },
        type: { $in: [ChatType.PRIVATE, ChatType.GROUP] },
        isDeleted: { $ne: true },
      })
      .select("_id")
      .lean()
      .exec();
    if (!chats.length) return;
    const viewerIds: string[] = (
      await this.chatMembersModel
        .distinct("userId", {
          channelId: { $in: chats.map(c => String(c._id)) },
          userId: { $ne: userId },
          isJoined: true,
          isBanned: { $ne: true },
        })
        .exec()
    ).map(String);
    if (!viewerIds.length) return;
    const graph = await this.privacy.forTarget(userId, viewerIds);
    const rooms = viewerIds
      .filter(v => graph.lastSeenVisible(userId, v))
      .map(v => `user:${v}`);
    if (rooms.length)
      this.getChatNamespace().to(rooms).emit("user_status_changed", payload);
  }

  /** Resolve the Socket.IO namespace (NestJS may inject main Server or Namespace). */
  private getChatNamespace(): Namespace {
    const s = this.server as unknown as {
      adapter?: { rooms: Map<string, Set<string>> };
      of?: (name: string) => Namespace;
    };
    if (s.adapter) return this.server as unknown as Namespace;
    if (typeof s.of === "function") {
      return this.server.of(ChatGateway.CHAT_NAMESPACE);
    }
    return this.server as unknown as Namespace;
  }

  async handleConnection(client: SocketAuth) {
    try {
      const token = this.extractToken(client);
      if (!token) {
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify<JWTPayload>(token, {
        secret: this.configService.get<string>("JWT_SECRET"),
      });

      const dbUser = await this.userModel
        .findById(payload.userId)
        .select("username email tokenVersion isDeleted suspendedUntil")
        .lean()
        .exec();
      if (!dbUser || dbUser.isDeleted) {
        client.disconnect();
        return;
      }
      if (
        dbUser.suspendedUntil &&
        dbUser.suspendedUntil.getTime() > Date.now()
      ) {
        client.disconnect();
        return;
      }
      try {
        this.authService.assertTokenVersion(dbUser, payload);
      } catch {
        client.disconnect();
        return;
      }
      if (
        payload.sid &&
        (await this.authService.isSessionRevoked(payload.sid))
      ) {
        client.disconnect();
        return;
      }

      client.userId = payload.userId;
      client.sessionId = payload.sid;
      client.userEmail = payload.email;
      client.username = dbUser?.username ?? payload.userId;
      client.correlationId = randomUUID();
      this.logger.log(
        { correlationId: client.correlationId, userId: payload.userId },
        "socket connected",
      );

      if (!this.userSockets.has(payload.userId)) {
        this.userSockets.set(payload.userId, new Set());
      }
      this.userSockets.get(payload.userId)?.add(client.id);
      this.socketUsers.set(client.id, payload.userId);

      this.userStatuses.set(payload.userId, UserStatus.ONLINE);
      await this.updateUserLastSeen(payload.userId);
      await this.presenceService.markOnline(payload.userId);
      if (!this.presenceHeartbeats.has(payload.userId)) {
        this.presenceHeartbeats.set(
          payload.userId,
          setInterval(() => {
            void this.presenceService.touch(payload.userId);
          }, ChatGateway.PRESENCE_HEARTBEAT_MS),
        );
      }

      await client.join(`user:${payload.userId}`);

      const memberships = await this.chatMembersModel.find({
        userId: payload.userId,
      });
      await Promise.all(
        memberships.map(m =>
          Promise.resolve(client.join(`channel:${m.channelId}`)),
        ),
      );

      for (const hook of this.connectHooks) {
        try {
          await hook(payload.userId, client.id);
        } catch (error) {
          const errLog: { err: unknown } = { err: error };
          this.logger.error(errLog, "socket connect hook failed");
        }
      }

      await this.broadcastPresence(payload.userId, {
        userId: payload.userId,
        status: UserStatus.ONLINE,
      });
    } catch (error) {
      const errLog: { err: unknown } = { err: error };
      this.logger.error(errLog, "socket connection error");
      client.disconnect();
    }
  }

  async handleDisconnect(client: SocketAuth) {
    this.sendMessageBuckets.delete(client.id);
    const userId = this.socketUsers.get(client.id);
    if (!userId) return;
    this.logger.log(
      { correlationId: client.correlationId, userId },
      "socket disconnected",
    );

    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(client.id);
      if (sockets.size === 0) {
        this.userStatuses.set(userId, UserStatus.OFFLINE);
        const lastSeen = await this.updateUserLastSeen(userId);
        await this.presenceService.markOffline(userId);
        const heartbeat = this.presenceHeartbeats.get(userId);
        if (heartbeat) {
          clearInterval(heartbeat);
          this.presenceHeartbeats.delete(userId);
        }
        await this.broadcastPresence(userId, {
          userId,
          status: UserStatus.OFFLINE,
          lastSeen: lastSeen?.toISOString?.() ?? new Date().toISOString(),
        });
        this.userSockets.delete(userId);
      }
    }
    this.socketUsers.delete(client.id);
  }

  /** A device was signed out: its open sockets go too (their access token would still pass otherwise). */
  @OnEvent("auth.session_revoked")
  onSessionRevoked(event: { familyId: string }) {
    for (const socket of this.server.sockets.sockets.values()) {
      if ((socket as SocketAuth).sessionId === event.familyId)
        socket.disconnect(true);
    }
  }

  @SubscribeMessage("join_channel")
  async handleJoinChannel(
    @ConnectedSocket() client: SocketAuth,
    @MessageBody() data: { channelId: string },
  ) {
    if (!client.userId) return { error: "Unauthorized" };
    const membership = await this.chatMembersModel.findOne({
      channelId: data.channelId,
      userId: client.userId,
    });
    if (!membership) return { error: "Access denied" };
    await client.join(`channel:${data.channelId}`);
    return { success: true, channelId: data.channelId };
  }

  @SubscribeMessage("leave_channel")
  async handleLeaveChannel(
    @ConnectedSocket() client: SocketAuth,
    @MessageBody() data: { channelId: string },
  ) {
    if (!client.userId) return { error: "Unauthorized" };
    await client.leave(`channel:${data.channelId}`);
    return { success: true, channelId: data.channelId };
  }

  @SubscribeMessage("send_message")
  async handleSendMessage(
    @ConnectedSocket() client: SocketAuth,
    @MessageBody() dto: CreateMessageDto,
  ) {
    if (!client.userId) return { error: "Unauthorized" };
    if (this.isSendMessageRateLimited(client.id)) {
      return { error: "rate_limited" };
    }
    try {
      const message = await this.messageService.create(dto, client.userId);
      const messageObj = JSON.parse(JSON.stringify(message)) as Message;
      const tempId = dto.tempId ?? null;
      const payload = {
        message: messageObj,
        channelId: dto.channelId,
        ...(tempId ? { tempId } : {}),
      };
      const room = `channel:${dto.channelId}`;
      await client.join(room);
      const chat = await this.chatModel
        .findById(dto.channelId)
        .select("type")
        .lean()
        .exec();
      const isPrivate = chat?.type === ChatType.PRIVATE;
      const senderId = client.userId;
      // Direct chats: someone who blocked the sender doesn't get it live.
      await this.emitMessageEvent(
        room,
        "new_message",
        payload,
        isPrivate
          ? async uid =>
              uid === senderId ||
              !(await this.userService.isBlocked(uid, senderId))
          : undefined,
      );
      return { success: true, message: messageObj };
    } catch (error: unknown) {
      return {
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  @SubscribeMessage("typing_start")
  async handleTypingStart(
    @ConnectedSocket() client: SocketAuth,
    @MessageBody() data: { channelId: string },
  ) {
    if (!client.userId) return { error: "Unauthorized" };
    const membership = await this.chatMembersModel.findOne({
      channelId: data.channelId,
      userId: client.userId,
    });
    if (!membership) return { error: "Access denied" };

    const channelTyping = this.typingUsers.get(data.channelId);
    if (channelTyping?.has(client.userId)) {
      clearTimeout(channelTyping.get(client.userId));
    }
    if (!channelTyping) {
      this.typingUsers.set(data.channelId, new Map());
    }
    const timeout = setTimeout(() => {
      this.typingUsers.get(data.channelId)?.delete(client.userId!);
      client.to(`channel:${data.channelId}`).emit("user_typing", {
        userId: client.userId,
        username: client.username,
        channelId: data.channelId,
        isTyping: false,
        uploading: false,
      });
    }, 5000);
    this.typingUsers.get(data.channelId)?.set(client.userId, timeout);

    client.to(`channel:${data.channelId}`).emit("user_typing", {
      userId: client.userId,
      username: client.username,
      channelId: data.channelId,
      isTyping: true,
      uploading: false,
    });
    return { success: true };
  }

  @SubscribeMessage("uploading_start")
  async handleUploadingStart(
    @ConnectedSocket() client: SocketAuth,
    @MessageBody() data: { channelId: string },
  ) {
    if (!client.userId) return { error: "Unauthorized" };
    const membership = await this.chatMembersModel.findOne({
      channelId: data.channelId,
      userId: client.userId,
    });
    if (!membership) return { error: "Access denied" };

    if (!this.uploadingUsers.has(data.channelId)) {
      this.uploadingUsers.set(data.channelId, new Set());
    }
    this.uploadingUsers.get(data.channelId)?.add(client.userId);

    client.to(`channel:${data.channelId}`).emit("user_typing", {
      userId: client.userId,
      username: client.username,
      channelId: data.channelId,
      isTyping: false,
      uploading: true,
    });
    return { success: true };
  }

  @SubscribeMessage("uploading_stop")
  handleUploadingStop(
    @ConnectedSocket() client: SocketAuth,
    @MessageBody() data: { channelId: string },
  ) {
    if (!client.userId) return { error: "Unauthorized" };
    const channelUploading = this.uploadingUsers.get(data.channelId);
    if (channelUploading?.has(client.userId)) {
      channelUploading.delete(client.userId);
      if (channelUploading.size === 0)
        this.uploadingUsers.delete(data.channelId);
    }
    client.to(`channel:${data.channelId}`).emit("user_typing", {
      userId: client.userId,
      username: client.username,
      channelId: data.channelId,
      isTyping: false,
      uploading: false,
    });
    return { success: true };
  }

  @SubscribeMessage("typing_stop")
  handleTypingStop(
    @ConnectedSocket() client: SocketAuth,
    @MessageBody() data: { channelId: string },
  ) {
    if (!client.userId) return { error: "Unauthorized" };
    const channelTyping = this.typingUsers.get(data.channelId);
    if (channelTyping?.has(client.userId)) {
      clearTimeout(channelTyping.get(client.userId));
      channelTyping.delete(client.userId);
    }
    client.to(`channel:${data.channelId}`).emit("user_typing", {
      userId: client.userId,
      username: client.username,
      channelId: data.channelId,
      isTyping: false,
      uploading: false,
    });
    return { success: true };
  }

  /**
   * Reconnect resync (B3): client sends `{since: {channelId: lastMessageId}}` on reconnect;
   * server streams back whatever each channel missed while the socket was down, in one ack
   * instead of a full history re-fetch per channel.
   */
  @SubscribeMessage("resync")
  async handleResync(
    @ConnectedSocket() client: SocketAuth,
    @MessageBody() data: { since: Record<string, string> },
  ) {
    if (!client.userId) return { error: "Unauthorized" };
    const since = data?.since ?? {};
    const result: Record<string, unknown> = {};
    for (const [channelId, lastMessageId] of Object.entries(since)) {
      try {
        result[channelId] = await this.messageService.findSinceMessage(
          channelId,
          client.userId,
          lastMessageId,
        );
      } catch (error: unknown) {
        result[channelId] = {
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
    return { success: true, channels: result };
  }

  @SubscribeMessage("mark_read")
  async handleMarkRead(
    @ConnectedSocket() client: SocketAuth,
    @MessageBody() data: { channelId: string; lastReadMessageId: string },
  ) {
    if (!client.userId) return { error: "Unauthorized" };
    try {
      const result = await this.messageService.markAsRead(
        data.channelId,
        client.userId,
        data.lastReadMessageId,
      );
      this.notifyReadUpdated(data.channelId, {
        userId: client.userId,
        lastReadMessageId: data.lastReadMessageId,
        upToCreatedAt: result.upToCreatedAt,
      });
      return { success: true };
    } catch (error: unknown) {
      return {
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  @SubscribeMessage("update_status")
  handleUpdateStatus(
    @ConnectedSocket() client: SocketAuth,
    @MessageBody() data: { status: UserStatus },
  ) {
    if (!client.userId) return { error: "Unauthorized" };
    this.userStatuses.set(client.userId, data.status);
    void this.broadcastPresence(client.userId, {
      userId: client.userId,
      status: data.status,
    });
    return { success: true, status: data.status };
  }

  /** Called by ChatController after creating a direct chat so both users see it instantly */
  async notifyNewChat(targetUserId: string, chat: unknown) {
    this.server.to(`user:${targetUserId}`).emit("new_chat", { chat });
    const chatObj = chat as { _id?: Types.ObjectId | string };
    const channelId = chatObj._id != null ? String(chatObj._id) : null;
    if (channelId) {
      const sockets = this.userSockets.get(targetUserId);
      if (sockets) {
        for (const socketId of sockets) {
          const socket = this.getChatNamespace().sockets.get(socketId);
          if (socket) await socket.join(`channel:${channelId}`);
        }
      }
    }
  }

  private extractToken(client: Socket): string | null {
    const authHeader = client.handshake.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.substring(7);
    }
    return (client.handshake.auth as { token?: string })?.token ?? null;
  }

  private async updateUserLastSeen(userId: string): Promise<Date | null> {
    const now = new Date();
    try {
      await this.userModel.updateOne(
        { _id: userId },
        { $set: { lastSeen: now } },
      );
      return now;
    } catch (error) {
      const errLog: { err: unknown } = { err: error };
      this.logger.error(errLog, "error updating last seen");
      return null;
    }
  }

  getUserStatus(userId: string): UserStatus {
    return this.userStatuses.get(userId) || UserStatus.OFFLINE;
  }

  isUserOnline(userId: string): boolean {
    return (
      this.userSockets.has(userId) &&
      (this.userSockets.get(userId)?.size ?? 0) > 0
    );
  }
}
