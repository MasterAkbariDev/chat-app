import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Block, BlockSchema } from "src/user/schema/block.schema";
import { ChatType, UserRole } from "src/enum/base.enum";
import type { CallsService as CallsServiceType } from "./calls.service";
import type { CallStateService, CallState } from "./call-state.service";
import type { LiveKitTokenService } from "./livekit-token.service";
import type { MessageService } from "src/message/message.service";
import type { ChatGateway } from "src/gateway/chat.gateway";
import { privacyServiceFor } from "src/common/testing/privacy";
import type { EventEmitter2 } from "@nestjs/event-emitter";

/** In-memory stand-in for the Redis-backed CallStateService (same contract, see
 *  call-state.service.spec.ts for the real thing against Redis). */
class FakeCallState {
  store = new Map<string, CallState>();
  byChannel = new Map<string, string>();
  ringing = new Map<string, Set<string>>();
  finalized = new Set<string>();
  active = new Set<string>();

  claimChannel = jest.fn((channelId: string, callId: string) => {
    if (this.byChannel.has(channelId)) return Promise.resolve(false);
    this.byChannel.set(channelId, callId);
    return Promise.resolve(true);
  });
  create = jest.fn((state: CallState) => {
    this.store.set(state.callId, structuredClone(state));
    this.active.add(state.callId);
    for (const u of state.ringingUserIds ?? []) {
      if (!this.ringing.has(u)) this.ringing.set(u, new Set());
      this.ringing.get(u)!.add(state.callId);
    }
    return Promise.resolve();
  });
  get = jest.fn((callId: string) => {
    const s = this.store.get(callId);
    return Promise.resolve(s ? structuredClone(s) : null);
  });
  getMany = jest.fn((ids: string[]) =>
    Promise.resolve(
      ids
        .map(id => this.store.get(id))
        .filter((s): s is CallState => !!s)
        .map(s => structuredClone(s)),
    ),
  );
  save = jest.fn((state: CallState) => {
    this.store.set(state.callId, structuredClone(state));
    return Promise.resolve();
  });
  getActiveCallIdForChannel = jest.fn((channelId: string) =>
    Promise.resolve(this.byChannel.get(channelId) ?? null),
  );
  getActivePrivateCallIdForChannel = this.getActiveCallIdForChannel;
  ringingCallIdsFor = jest.fn((userId: string) =>
    Promise.resolve([...(this.ringing.get(userId) ?? [])]),
  );
  stopRinging = jest.fn((userIds: string[], callId: string) => {
    for (const u of userIds) this.ringing.get(u)?.delete(callId);
    return Promise.resolve();
  });
  activeCallIds = jest.fn(() => Promise.resolve([...this.active]));
  acquireFinalize = jest.fn((callId: string) => {
    if (this.finalized.has(callId)) return Promise.resolve(false);
    this.finalized.add(callId);
    return Promise.resolve(true);
  });
  delete = jest.fn(
    (
      callId: string,
      channelId: string,
      _isPrivate?: boolean,
      ringingUserIds: string[] = [],
    ) => {
      this.store.delete(callId);
      this.active.delete(callId);
      for (const u of ringingUserIds) this.ringing.get(u)?.delete(callId);
      if (this.byChannel.get(channelId) === callId) {
        this.byChannel.delete(channelId);
      }
      return Promise.resolve();
    },
  );
}

interface RingPayload {
  isPrivate: boolean;
  fromUsername: string;
}

interface CallLogDto {
  content: string;
}

interface CallLogContent {
  callLog: true;
  kind: "missed" | "declined" | "ended";
  durationMinutes?: number;
}

function parseCallLog(dto: CallLogDto): CallLogContent {
  return JSON.parse(dto.content) as CallLogContent;
}

describe("CallsService (B8: create/join/leave/decline, block enforcement, one call-log message)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatMembersModel: Model<ChatMembers>;
  let ChatModel: Model<Chat>;
  let UserModel: Model<User>;
  let BlockModel: Model<Block>;
  let CallsService: typeof CallsServiceType;
  let service: CallsServiceType;

  let fakeCallState: FakeCallState;
  let fakeLiveKit: {
    createRoomToken: jest.Mock;
    livekitUrl: string;
    listParticipantIdentities: jest.Mock<Promise<string[] | null>, [string]>;
  };
  let fakeEvents: { emit: jest.Mock };
  let fakeMessageService: {
    create: jest.Mock<
      Promise<{ _id: string; channelId: string }>,
      [CallLogDto, string, unknown?]
    >;
  };
  let fakeGateway: {
    notifyCallRinging: jest.Mock<void, [string, RingPayload]>;
    notifyCallEnded: jest.Mock;
    notifyCallMissed: jest.Mock;
    notifyCallHandled: jest.Mock;
    notifyGroupCallUpdated: jest.Mock;
    broadcastNewMessage: jest.Mock;
    onUserConnected: jest.Mock;
  };

  beforeAll(async () => {
    // calls.service.ts imports the real ChatGateway (needed for Nest DI's constructor
    // metadata), whose @WebSocketGateway decorator reads CORS_ORIGIN at module-load time.
    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";
    ({ CallsService } = await import("./calls.service"));

    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    UserModel = connection.model(User.name, UserSchema);
    BlockModel = connection.model(Block.name, BlockSchema);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  beforeEach(() => {
    fakeCallState = new FakeCallState();
    fakeLiveKit = {
      createRoomToken: jest.fn().mockResolvedValue("fake.jwt.token"),
      livekitUrl: "ws://localhost:7880",
      listParticipantIdentities: jest
        .fn<Promise<string[] | null>, [string]>()
        .mockResolvedValue(null),
    };
    fakeEvents = { emit: jest.fn() };
    fakeMessageService = {
      create: jest
        .fn<
          Promise<{ _id: string; channelId: string }>,
          [CallLogDto, string, unknown?]
        >()
        .mockResolvedValue({ _id: "msg1", channelId: "c1" }),
    };
    fakeGateway = {
      notifyCallRinging: jest.fn<void, [string, RingPayload]>(),
      notifyCallEnded: jest.fn(),
      notifyCallMissed: jest.fn(),
      notifyCallHandled: jest.fn(),
      notifyGroupCallUpdated: jest.fn(),
      broadcastNewMessage: jest.fn(),
      onUserConnected: jest.fn(),
    };
    service = new CallsService(
      ChatMembersModel,
      ChatModel,
      UserModel,
      BlockModel,
      fakeCallState as unknown as CallStateService,
      fakeLiveKit as unknown as LiveKitTokenService,
      fakeMessageService as unknown as MessageService,
      fakeGateway as unknown as ChatGateway,
      privacyServiceFor(connection),
      fakeEvents as unknown as EventEmitter2,
    );
  });

  afterEach(async () => {
    service.onModuleDestroy(); // clear pending ring timers
    await Promise.all([
      ChatMembersModel.deleteMany({}),
      ChatModel.deleteMany({}),
      UserModel.deleteMany({}),
      BlockModel.deleteMany({}),
    ]);
  });

  async function makeUser(overrides: Partial<User> = {}) {
    return UserModel.create({
      username: `u${Date.now()}${Math.random()}`.replace(".", ""),
      email: `${Date.now()}${Math.random()}@example.com`.replace(".", ""),
      password: "hashed",
      ...overrides,
    });
  }

  async function makePrivateChat(userA: string, userB: string) {
    const chat = await ChatModel.create({
      link: `private-${Date.now()}-${Math.random()}`,
      type: ChatType.PRIVATE,
    });
    const channelId = chat._id.toString();
    await ChatMembersModel.create({
      channelId,
      userId: userA,
      role: UserRole.MEMBER,
    });
    await ChatMembersModel.create({
      channelId,
      userId: userB,
      role: UserRole.MEMBER,
    });
    return channelId;
  }

  async function makeGroupChat(memberIds: string[]) {
    const chat = await ChatModel.create({
      link: `group-${Date.now()}-${Math.random()}`,
      type: ChatType.GROUP,
      name: "Test Group",
    });
    const channelId = chat._id.toString();
    await ChatMembersModel.insertMany(
      memberIds.map(userId => ({
        channelId,
        userId,
        role: UserRole.MEMBER,
      })),
    );
    return channelId;
  }

  describe("createCall", () => {
    it("rings the other member of a private chat", async () => {
      const caller = await makeUser({ username: "caller" });
      const callee = await makeUser({ username: "callee" });
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );

      const result = await service.createCall(channelId, caller._id.toString());

      expect(result.callId).toBeDefined();
      expect(result.roomToken).toBe("fake.jwt.token");
      expect(fakeGateway.notifyCallRinging).toHaveBeenCalledTimes(1);
      const [ringUserId, payload] = fakeGateway.notifyCallRinging.mock.calls[0];
      expect(ringUserId).toBe(callee._id.toString());
      expect(payload.isPrivate).toBe(true);
      expect(payload.fromUsername).toBe("caller");
    });

    it("group chat: starts a voice chat without ringing anyone, posts a service message and broadcasts the roster", async () => {
      const caller = await makeUser({ firstName: "Maya" });
      const memberB = await makeUser();
      const memberC = await makeUser();
      const channelId = await makeGroupChat([
        caller._id.toString(),
        memberB._id.toString(),
        memberC._id.toString(),
      ]);

      const { callId } = await service.createCall(
        channelId,
        caller._id.toString(),
      );
      expect(fakeGateway.notifyCallRinging).not.toHaveBeenCalled();
      expect(fakeMessageService.create).toHaveBeenCalledTimes(1);
      const [dto, senderId, internal] = fakeMessageService.create.mock.calls[0];
      expect(dto).toMatchObject({
        channelId,
        content: "voice_chat_started",
        type: "system",
      });
      expect(senderId).toBe(caller._id.toString());
      expect(internal).toEqual({
        metadata: { senderName: "Maya", callId },
      });
      expect(fakeGateway.notifyGroupCallUpdated).toHaveBeenCalledWith(
        channelId,
        expect.objectContaining({
          callId,
          participants: [
            expect.objectContaining({
              _id: caller._id.toString(),
              name: "Maya",
            }),
          ],
        }),
      );
    });

    it("rejects a caller who isn't a member of the channel", async () => {
      const caller = await makeUser();
      const other = await makeUser();
      const channelId = await makePrivateChat(
        other._id.toString(),
        (await makeUser())._id.toString(),
      );
      await expect(
        service.createCall(channelId, caller._id.toString()),
      ).rejects.toThrow(/access denied/i);
    });

    it("blocks a private call if either side has blocked the other", async () => {
      const caller = await makeUser();
      const callee = await makeUser();
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );
      await BlockModel.create({
        blockerId: callee._id,
        blockedId: caller._id,
      });

      await expect(
        service.createCall(channelId, caller._id.toString()),
      ).rejects.toThrow(/can't call this user/i);
    });

    it("rejects a second concurrent private call on the same channel", async () => {
      const caller = await makeUser();
      const callee = await makeUser();
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );
      await service.createCall(channelId, caller._id.toString());

      await expect(
        service.createCall(channelId, caller._id.toString()),
      ).rejects.toThrow(/already in progress/i);
    });
  });

  describe("joinCall", () => {
    it("marks the call as started once a second participant joins", async () => {
      const caller = await makeUser();
      const callee = await makeUser();
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );
      const { callId } = await service.createCall(
        channelId,
        caller._id.toString(),
      );

      await service.joinCall(callId, caller._id.toString());
      expect(fakeCallState.store.get(callId)?.startedAt).toBeNull();

      await service.joinCall(callId, callee._id.toString());
      expect(fakeCallState.store.get(callId)?.startedAt).not.toBeNull();
    });

    it("marks the call as started from just the callee's join — the caller never calls /join in real usage", async () => {
      // The frontend never calls `joinCall` for the caller (they already have a room
      // token from `createCall`'s own response) — only the callee's Accept button does.
      // A regression here would mean every real, answered private call still finalizes
      // as "missed"/"No answer" (found live-testing the calls UI against two real
      // accounts: `participantIds` started `[]`, so the callee's own join could only
      // ever bring the count to 1, never the 2 this check requires).
      const caller = await makeUser();
      const callee = await makeUser();
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );
      const { callId } = await service.createCall(
        channelId,
        caller._id.toString(),
      );

      await service.joinCall(callId, callee._id.toString());
      expect(fakeCallState.store.get(callId)?.startedAt).not.toBeNull();
    });

    it("rejects a non-member trying to join", async () => {
      const caller = await makeUser();
      const callee = await makeUser();
      const stranger = await makeUser();
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );
      const { callId } = await service.createCall(
        channelId,
        caller._id.toString(),
      );

      await expect(
        service.joinCall(callId, stranger._id.toString()),
      ).rejects.toThrow(/access denied/i);
    });

    it("enforces the group call participant cap", async () => {
      const caller = await makeUser();
      const memberIds = [caller._id.toString()];
      for (let i = 0; i < 16; i++) {
        memberIds.push((await makeUser())._id.toString());
      }
      const channelId = await makeGroupChat(memberIds);
      const { callId } = await service.createCall(
        channelId,
        caller._id.toString(),
      );

      for (let i = 0; i < 16; i++) {
        await service.joinCall(callId, memberIds[i]);
      }
      await expect(service.joinCall(callId, memberIds[16])).rejects.toThrow(
        /call is full/i,
      );
    });

    it("throws for a call that doesn't exist", async () => {
      const user = await makeUser();
      await expect(
        service.joinCall("nonexistent", user._id.toString()),
      ).rejects.toThrow(/not found|already ended/i);
    });
  });

  describe("leaveCall / declineCall — exactly one call-log message per call", () => {
    it("private call: either side leaving ends it immediately with kind=missed if never answered", async () => {
      const caller = await makeUser();
      const callee = await makeUser();
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );
      const { callId } = await service.createCall(
        channelId,
        caller._id.toString(),
      );

      await service.leaveCall(callId, caller._id.toString());

      expect(fakeMessageService.create).toHaveBeenCalledTimes(1);
      const [dto] = fakeMessageService.create.mock.calls[0];
      const content = parseCallLog(dto);
      expect(content).toEqual({ callLog: true, kind: "missed" });
      expect(fakeGateway.notifyCallEnded).toHaveBeenCalledTimes(1);
      expect(fakeGateway.notifyCallMissed).toHaveBeenCalledTimes(1);
      expect(fakeCallState.store.has(callId)).toBe(false);
    });

    it("private call: kind=ended with duration once answered then hung up", async () => {
      const caller = await makeUser();
      const callee = await makeUser();
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );
      const { callId } = await service.createCall(
        channelId,
        caller._id.toString(),
      );
      await service.joinCall(callId, caller._id.toString());
      await service.joinCall(callId, callee._id.toString());

      await service.leaveCall(callId, callee._id.toString());

      const [dto] = fakeMessageService.create.mock.calls[0];
      const content = parseCallLog(dto);
      expect(content.kind).toBe("ended");
      expect(content.durationMinutes).toBeGreaterThanOrEqual(1);
    });

    it("declineCall: kind=declined, and rejects for a group call", async () => {
      const caller = await makeUser();
      const callee = await makeUser();
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );
      const { callId } = await service.createCall(
        channelId,
        caller._id.toString(),
      );

      await service.declineCall(callId, callee._id.toString());
      const [dto] = fakeMessageService.create.mock.calls[0];
      expect(JSON.parse(dto.content)).toEqual({
        callLog: true,
        kind: "declined",
      });

      // A group call can't be declined.
      const caller2 = await makeUser();
      const member2 = await makeUser();
      const groupChannelId = await makeGroupChat([
        caller2._id.toString(),
        member2._id.toString(),
      ]);
      const { callId: groupCallId } = await service.createCall(
        groupChannelId,
        caller2._id.toString(),
      );
      await expect(
        service.declineCall(groupCallId, member2._id.toString()),
      ).rejects.toThrow(/only private calls/i);
    });

    it("group call: only ends once every participant has left", async () => {
      const caller = await makeUser();
      const memberB = await makeUser();
      const channelId = await makeGroupChat([
        caller._id.toString(),
        memberB._id.toString(),
      ]);
      const { callId } = await service.createCall(
        channelId,
        caller._id.toString(),
      );
      await service.joinCall(callId, caller._id.toString());
      await service.joinCall(callId, memberB._id.toString());

      fakeMessageService.create.mockClear();
      await service.leaveCall(callId, caller._id.toString());
      expect(fakeMessageService.create).not.toHaveBeenCalled();
      expect(fakeCallState.store.has(callId)).toBe(true);

      await service.leaveCall(callId, memberB._id.toString());
      expect(fakeMessageService.create).toHaveBeenCalledTimes(1);
      const [dto, , internal] = fakeMessageService.create.mock.calls[0];
      expect(dto.content).toBe("voice_chat_ended");
      expect(
        (internal as { metadata: { durationMinutes: number } }).metadata
          .durationMinutes,
      ).toBeGreaterThanOrEqual(1);
      expect(fakeCallState.store.has(callId)).toBe(false);
      expect(fakeCallState.byChannel.has(channelId)).toBe(false);
      expect(fakeGateway.notifyGroupCallUpdated).toHaveBeenLastCalledWith(
        channelId,
        { callId: null, startedAt: null, participants: [] },
      );
    });

    it("leaving/declining a call that's already gone is a harmless no-op", async () => {
      const user = await makeUser();
      await expect(
        service.leaveCall("gone", user._id.toString()),
      ).resolves.toEqual({ success: true });
      await expect(
        service.declineCall("gone", user._id.toString()),
      ).resolves.toEqual({ success: true });
      expect(fakeMessageService.create).not.toHaveBeenCalled();
    });
  });

  describe('ring delivery — "sometimes calls are not notified"', () => {
    async function ringing() {
      const caller = await makeUser({ username: "caller" });
      const callee = await makeUser({ username: "callee" });
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );
      const { callId } = await service.createCall(
        channelId,
        caller._id.toString(),
      );
      return {
        callerId: caller._id.toString(),
        calleeId: callee._id.toString(),
        channelId,
        callId,
      };
    }

    it("a socket that connects after the ring went out still rings (connect hook → that socket only)", async () => {
      const { calleeId, callId, channelId } = await ringing();
      service.onModuleInit();
      const hook = (
        fakeGateway.onUserConnected.mock.calls as unknown[][]
      )[0][0] as (u: string, s: string) => Promise<void>;
      fakeGateway.notifyCallRinging.mockClear();

      await hook(calleeId, "socket-late");

      expect(fakeGateway.notifyCallRinging).toHaveBeenCalledTimes(1);
      const [userId, payload, socketId] = fakeGateway.notifyCallRinging.mock
        .calls[0] as unknown as [
        string,
        RingPayload & { callId: string; channelId: string; expiresAt: number },
        string,
      ];
      expect(userId).toBe(calleeId);
      expect(socketId).toBe("socket-late");
      expect(payload).toMatchObject({ callId, channelId, isPrivate: true });
      expect(payload.expiresAt).toBeGreaterThan(Date.now());
    });

    it("pendingIncomingCalls: only the callee, only until answered", async () => {
      const { callerId, calleeId, callId } = await ringing();
      expect(await service.pendingIncomingCalls(callerId)).toEqual([]);
      expect(
        (await service.pendingIncomingCalls(calleeId)).map(c => c.callId),
      ).toEqual([callId]);

      await service.joinCall(callId, calleeId);
      expect(await service.pendingIncomingCalls(calleeId)).toEqual([]);
      // Other tabs/devices of the callee stop ringing.
      expect(fakeGateway.notifyCallHandled).toHaveBeenCalledWith(
        calleeId,
        expect.objectContaining({ callId, action: "answered" }),
      );
    });

    it("the caller cancelling before the callee connects leaves nothing to ring", async () => {
      const { callerId, calleeId, callId } = await ringing();
      await service.leaveCall(callId, callerId);
      expect(await service.pendingIncomingCalls(calleeId)).toEqual([]);
      // call:ended also reaches the callee's own room, not just the chat room.
      const [, , userIds] = fakeGateway.notifyCallEnded.mock.calls[0] as [
        string,
        unknown,
        string[],
      ];
      expect(userIds).toEqual(expect.arrayContaining([callerId, calleeId]));
    });

    it("an expired ring found on lookup is finalized as missed, not re-rung", async () => {
      const { calleeId, callId } = await ringing();
      const state = fakeCallState.store.get(callId)!;
      state.ringExpiresAt = Date.now() - 1;
      expect(await service.pendingIncomingCalls(calleeId)).toEqual([]);
      expect(parseCallLog(fakeMessageService.create.mock.calls[0][0])).toEqual({
        callLog: true,
        kind: "missed",
      });
      expect(fakeCallState.store.has(callId)).toBe(false);
    });

    it("ring timeout: an unanswered call ends as missed after RING_TIMEOUT_MS", async () => {
      const { callId } = await ringing();
      // The sweep (restart-safe path) — and the per-process timer calls the same expireRing.
      fakeCallState.store.get(callId)!.ringExpiresAt = Date.now() - 1;
      await service.sweep();
      expect(fakeCallState.store.has(callId)).toBe(false);
      expect(fakeGateway.notifyCallEnded).toHaveBeenCalledWith(
        expect.any(String),
        { callId, kind: "missed" },
        expect.any(Array),
      );
      expect(fakeGateway.notifyCallMissed).toHaveBeenCalledTimes(1);
    });

    it("emits CALL_RINGING (push) for the callee, and CALL_RING_STOPPED once handled", async () => {
      const { calleeId, callId, callerId } = await ringing();
      expect(fakeEvents.emit).toHaveBeenCalledWith(
        "call.ringing",
        expect.objectContaining({
          callId,
          callerId,
          callerName: "caller",
          calleeIds: [calleeId],
        }),
      );
      await service.declineCall(callId, calleeId);
      expect(fakeEvents.emit).toHaveBeenCalledWith(
        "call.ring_stopped",
        expect.objectContaining({
          callId,
          userIds: [calleeId],
          reason: "declined",
        }),
      );
    });

    it("racing hang-ups write exactly one call log", async () => {
      const { callerId, calleeId, callId } = await ringing();
      await Promise.all([
        service.leaveCall(callId, callerId),
        service.declineCall(callId, calleeId),
        service.expireRing(callId),
      ]);
      expect(fakeMessageService.create).toHaveBeenCalledTimes(1);
      expect(fakeGateway.notifyCallEnded).toHaveBeenCalledTimes(1);
    });

    it("still rings a callee who deleted the DM on their side (isJoined: false)", async () => {
      const caller = await makeUser();
      const callee = await makeUser();
      const channelId = await makePrivateChat(
        caller._id.toString(),
        callee._id.toString(),
      );
      await ChatMembersModel.updateOne(
        { channelId, userId: callee._id.toString() },
        { $set: { isJoined: false } },
      );
      await service.createCall(channelId, caller._id.toString());
      expect(fakeGateway.notifyCallRinging).toHaveBeenCalledWith(
        callee._id.toString(),
        expect.objectContaining({ isPrivate: true }),
      );
    });
  });

  describe("group voice chats", () => {
    it("a second start joins the running voice chat instead of creating another", async () => {
      const a = await makeUser();
      const b = await makeUser();
      const channelId = await makeGroupChat([
        a._id.toString(),
        b._id.toString(),
      ]);
      const first = await service.createCall(channelId, a._id.toString());
      const second = await service.createCall(channelId, b._id.toString());
      expect(second.callId).toBe(first.callId);
      expect(fakeCallState.store.get(first.callId)?.participantIds).toEqual([
        a._id.toString(),
        b._id.toString(),
      ]);
      // Only one "started" message.
      expect(
        fakeMessageService.create.mock.calls.filter(
          c => c[0].content === "voice_chat_started",
        ),
      ).toHaveLength(1);
    });

    it("activeGroupCall: members see it (with roster), non-members are refused", async () => {
      const a = await makeUser({ firstName: "Ann" });
      const stranger = await makeUser();
      const channelId = await makeGroupChat([a._id.toString()]);
      expect(
        await service.activeGroupCall(channelId, a._id.toString()),
      ).toBeNull();
      const { callId } = await service.createCall(channelId, a._id.toString());
      expect(
        await service.activeGroupCall(channelId, a._id.toString()),
      ).toMatchObject({
        callId,
        channelId,
        participants: [{ _id: a._id.toString(), name: "Ann", photo: null }],
      });
      await expect(
        service.activeGroupCall(channelId, stranger._id.toString()),
      ).rejects.toThrow(/access denied/i);
    });

    it("someone who left the group can't join its voice chat", async () => {
      const a = await makeUser();
      const b = await makeUser();
      const channelId = await makeGroupChat([
        a._id.toString(),
        b._id.toString(),
      ]);
      const { callId } = await service.createCall(channelId, a._id.toString());
      await ChatMembersModel.updateOne(
        { channelId, userId: b._id.toString() },
        { $set: { isJoined: false } },
      );
      await expect(service.joinCall(callId, b._id.toString())).rejects.toThrow(
        /access denied/i,
      );
    });

    it("channels: only admins start a voice chat, subscribers can join one", async () => {
      const owner = await makeUser();
      const sub = await makeUser();
      const chat = await ChatModel.create({
        link: `channel-${Date.now()}-${Math.random()}`,
        type: ChatType.CHANNEL,
        name: "News",
      });
      const channelId = chat._id.toString();
      await ChatMembersModel.insertMany([
        { channelId, userId: owner._id.toString(), role: UserRole.OWNER },
        { channelId, userId: sub._id.toString(), role: UserRole.MEMBER },
      ]);
      await expect(
        service.createCall(channelId, sub._id.toString()),
      ).rejects.toThrow(/only admins/i);
      const { callId } = await service.createCall(
        channelId,
        owner._id.toString(),
      );
      const joined = await service.createCall(channelId, sub._id.toString());
      expect(joined.callId).toBe(callId);
    });

    it("reconciliation: a participant gone from LiveKit for two sweeps is dropped; nobody left ends it", async () => {
      const a = await makeUser();
      const b = await makeUser();
      const channelId = await makeGroupChat([
        a._id.toString(),
        b._id.toString(),
      ]);
      const { callId } = await service.createCall(channelId, a._id.toString());
      await service.joinCall(callId, b._id.toString());
      const state = fakeCallState.store.get(callId)!;
      // Both joined long enough ago to be past the connect grace.
      state.joinedAt = {
        [a._id.toString()]: Date.now() - 120_000,
        [b._id.toString()]: Date.now() - 120_000,
      };
      fakeLiveKit.listParticipantIdentities.mockResolvedValue([
        a._id.toString(),
      ]);

      await service.sweep();
      expect(fakeCallState.store.get(callId)?.participantIds).toHaveLength(2);
      await service.sweep();
      expect(fakeCallState.store.get(callId)?.participantIds).toEqual([
        a._id.toString(),
      ]);

      fakeLiveKit.listParticipantIdentities.mockResolvedValue([]);
      await service.sweep();
      await service.sweep();
      expect(fakeCallState.store.has(callId)).toBe(false);
      expect(
        fakeMessageService.create.mock.calls.some(
          c => c[0].content === "voice_chat_ended",
        ),
      ).toBe(true);
    });

    it("reconciliation leaves calls alone when LiveKit can't be asked", async () => {
      const a = await makeUser();
      const channelId = await makeGroupChat([a._id.toString()]);
      const { callId } = await service.createCall(channelId, a._id.toString());
      fakeCallState.store.get(callId)!.joinedAt = {
        [a._id.toString()]: Date.now() - 120_000,
      };
      fakeLiveKit.listParticipantIdentities.mockResolvedValue(null);
      await service.sweep();
      await service.sweep();
      expect(fakeCallState.store.has(callId)).toBe(true);
    });
  });
});
