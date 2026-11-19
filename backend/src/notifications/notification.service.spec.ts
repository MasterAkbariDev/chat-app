import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { PushToken, PushTokenSchema } from "./schema/push-token.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { ChatType, UserRole } from "src/enum/base.enum";
import type { NotificationService as NotificationServiceType } from "./notification.service";
import type { ChatGateway } from "src/gateway/chat.gateway";
import type { FcmService } from "./fcm.service";
import type { MessageCreatedEvent } from "src/events/domain-events";
import type { FcmSendResult } from "./fcm.service";

type FakeSend = jest.Mock<
  Promise<FcmSendResult>,
  [string, { title: string; body: string }, Record<string, string>]
>;

describe("NotificationService (B7: should-notify decision + FCM fan-out)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let PushTokenModel: Model<PushToken>;
  let ChatMembersModel: Model<ChatMembers>;
  let ChatModel: Model<Chat>;
  let UserModel: Model<User>;
  let fakeGateway: { isUserInChannelRoom: jest.Mock };
  let fakeFcm: {
    isConfigured: boolean;
    send: FakeSend;
    sendData: jest.Mock<
      Promise<FcmSendResult>,
      [string, Record<string, string>, number]
    >;
  };
  let NotificationService: typeof NotificationServiceType;
  let service: NotificationServiceType;

  beforeAll(async () => {
    // notification.service.ts imports the real ChatGateway (needed for Nest DI's constructor
    // metadata), whose @WebSocketGateway decorator reads CORS_ORIGIN at module-load time — set
    // it before the (dynamic) first import, same pattern as chat.service.b2.spec.ts.
    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";
    ({ NotificationService } = await import("./notification.service"));

    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    PushTokenModel = connection.model(PushToken.name, PushTokenSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    UserModel = connection.model(User.name, UserSchema);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  beforeEach(() => {
    fakeGateway = { isUserInChannelRoom: jest.fn().mockReturnValue(false) };
    fakeFcm = {
      isConfigured: true,
      send: jest
        .fn<
          Promise<FcmSendResult>,
          [string, { title: string; body: string }, Record<string, string>]
        >()
        .mockResolvedValue({ ok: true, invalidToken: false }),
      sendData: jest
        .fn<Promise<FcmSendResult>, [string, Record<string, string>, number]>()
        .mockResolvedValue({ ok: true, invalidToken: false }),
    };
    service = new NotificationService(
      PushTokenModel,
      ChatMembersModel,
      ChatModel,
      UserModel,
      fakeGateway as unknown as ChatGateway,
      fakeFcm as unknown as FcmService,
    );
  });

  afterEach(async () => {
    await Promise.all([
      PushTokenModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
      ChatModel.deleteMany({}),
      UserModel.deleteMany({}),
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

  async function setup(chatType: ChatType, chatName = "Test Group") {
    const sender = await makeUser({ username: "sender" });
    const recipient = await makeUser({ username: "recipient" });
    const chat = await ChatModel.create({
      link: `test-${Date.now()}-${Math.random()}`,
      name: chatName,
      type: chatType,
    });
    const channelId = chat._id.toString();
    await ChatMembersModel.create({
      channelId,
      userId: sender._id.toString(),
      role: UserRole.MEMBER,
    });
    await ChatMembersModel.create({
      channelId,
      userId: recipient._id.toString(),
      role: UserRole.MEMBER,
    });
    await PushTokenModel.create({
      userId: recipient._id.toString(),
      platform: "android",
      token: `token-${recipient._id.toString()}`,
    });
    return { sender, recipient, channelId };
  }

  function event(
    overrides: Partial<MessageCreatedEvent> = {},
  ): MessageCreatedEvent {
    return {
      channelId: "",
      createdAt: new Date(),
      preview: "hello",
      senderId: "",
      messageId: new Types.ObjectId().toString(),
      mentions: [],
      ...overrides,
    };
  }

  it("does nothing when FCM isn't configured", async () => {
    fakeFcm.isConfigured = false;
    const { sender, channelId } = await setup(ChatType.GROUP);
    await service.onMessageCreated(
      event({ channelId, senderId: sender._id.toString() }),
    );
    expect(fakeFcm.send).not.toHaveBeenCalled();
  });

  it("sends to a recipient with a registered token, level=all", async () => {
    const { sender, channelId } = await setup(ChatType.GROUP);
    await service.onMessageCreated(
      event({
        channelId,
        senderId: sender._id.toString(),
        preview: "hi there",
      }),
    );
    expect(fakeFcm.send).toHaveBeenCalledTimes(1);
    const [, notification] = fakeFcm.send.mock.calls[0];
    expect(notification.body).toContain("hi there");
  });

  it("never notifies the sender", async () => {
    const { sender, channelId } = await setup(ChatType.GROUP);
    // Give the sender a token too — should still never be notified about their own message.
    await PushTokenModel.create({
      userId: sender._id.toString(),
      platform: "android",
      token: "sender-token",
    });
    await service.onMessageCreated(
      event({ channelId, senderId: sender._id.toString() }),
    );
    const calledTokens = fakeFcm.send.mock.calls.map(c => c[0]);
    expect(calledTokens).not.toContain("sender-token");
  });

  it("skips a recipient who has the channel open (gateway says so)", async () => {
    const { sender, recipient, channelId } = await setup(ChatType.GROUP);
    fakeGateway.isUserInChannelRoom.mockImplementation(
      (userId: string) => userId === recipient._id.toString(),
    );
    await service.onMessageCreated(
      event({ channelId, senderId: sender._id.toString() }),
    );
    expect(fakeFcm.send).not.toHaveBeenCalled();
  });

  it("skips a muted member", async () => {
    const { sender, recipient, channelId } = await setup(ChatType.GROUP);
    await ChatMembersModel.updateOne(
      { channelId, userId: recipient._id.toString() },
      { $set: { isMuted: true } },
    );
    await service.onMessageCreated(
      event({ channelId, senderId: sender._id.toString() }),
    );
    expect(fakeFcm.send).not.toHaveBeenCalled();
  });

  it("level=none never notifies", async () => {
    const { sender, recipient, channelId } = await setup(ChatType.GROUP);
    await UserModel.updateOne(
      { _id: recipient._id },
      { $set: { notificationLevel: "none" } },
    );
    await service.onMessageCreated(
      event({ channelId, senderId: sender._id.toString() }),
    );
    expect(fakeFcm.send).not.toHaveBeenCalled();
  });

  it("level=mentions only notifies when actually mentioned", async () => {
    const { sender, recipient, channelId } = await setup(ChatType.GROUP);
    await UserModel.updateOne(
      { _id: recipient._id },
      { $set: { notificationLevel: "mentions" } },
    );

    await service.onMessageCreated(
      event({ channelId, senderId: sender._id.toString(), mentions: [] }),
    );
    expect(fakeFcm.send).not.toHaveBeenCalled();

    await service.onMessageCreated(
      event({
        channelId,
        senderId: sender._id.toString(),
        mentions: [recipient._id.toString()],
      }),
    );
    expect(fakeFcm.send).toHaveBeenCalledTimes(1);
  });

  it("deletes a push token FCM reports as no longer registered", async () => {
    fakeFcm.send.mockResolvedValueOnce({ ok: false, invalidToken: true });
    const { sender, recipient, channelId } = await setup(ChatType.GROUP);

    await service.onMessageCreated(
      event({ channelId, senderId: sender._id.toString() }),
    );

    const remaining = await PushTokenModel.countDocuments({
      userId: recipient._id.toString(),
    });
    expect(remaining).toBe(0);
  });

  it("uses the sender's name (not the chat name) as the title for a private chat", async () => {
    const { sender, channelId } = await setup(ChatType.PRIVATE, "");
    await service.onMessageCreated(
      event({ channelId, senderId: sender._id.toString() }),
    );
    const [, notification] = fakeFcm.send.mock.calls[0];
    expect(notification.title).toBe("sender");
    expect(notification.body).not.toContain(":");
  });

  it("uses the chat name as the title for a group, prefixing the sender in the body", async () => {
    const { sender, channelId } = await setup(ChatType.GROUP, "Family Group");
    await service.onMessageCreated(
      event({ channelId, senderId: sender._id.toString(), preview: "yo" }),
    );
    const [, notification] = fakeFcm.send.mock.calls[0];
    expect(notification.title).toBe("Family Group");
    expect(notification.body).toBe("sender: yo");
  });

  describe("incoming call push", () => {
    it("sends a data-only high-priority 'incoming_call' push to every device of the callee — even with the chat muted", async () => {
      const { sender, recipient, channelId } = await setup(ChatType.PRIVATE);
      await ChatMembersModel.updateOne(
        { channelId, userId: recipient._id.toString() },
        { $set: { isMuted: true } },
      );
      await PushTokenModel.create({
        userId: recipient._id.toString(),
        platform: "android",
        token: "second-device",
      });
      const expiresAt = Date.now() + 45_000;
      await service.onCallRinging({
        callId: "call-1",
        channelId,
        callerId: sender._id.toString(),
        callerName: "Maya",
        calleeIds: [recipient._id.toString()],
        expiresAt,
      });

      expect(fakeFcm.send).not.toHaveBeenCalled(); // no auto-shown notification block
      expect(fakeFcm.sendData).toHaveBeenCalledTimes(2);
      const [token, data, ttl] = fakeFcm.sendData.mock.calls[0];
      expect([`token-${recipient._id.toString()}`, "second-device"]).toContain(
        token,
      );
      expect(data).toEqual({
        type: "incoming_call",
        callId: "call-1",
        channelId,
        fromUserId: sender._id.toString(),
        fromName: "Maya",
        isPrivate: "1",
        expiresAt: String(expiresAt),
      });
      // TTL ≈ the remaining ring, so a late delivery never rings for a dead call.
      expect(ttl).toBeGreaterThan(40);
      expect(ttl).toBeLessThanOrEqual(45);
    });

    it("withdraws it with a 'call_ended' push once the ring stops", async () => {
      const { recipient, channelId } = await setup(ChatType.PRIVATE);
      await service.onCallRingStopped({
        callId: "call-1",
        channelId,
        userIds: [recipient._id.toString()],
        reason: "answered",
      });
      expect(fakeFcm.sendData).toHaveBeenCalledWith(
        `token-${recipient._id.toString()}`,
        { type: "call_ended", callId: "call-1", channelId, reason: "answered" },
        60,
      );
    });

    it("drops a dead token, and does nothing without FCM", async () => {
      const { sender, recipient, channelId } = await setup(ChatType.PRIVATE);
      fakeFcm.sendData.mockResolvedValueOnce({ ok: false, invalidToken: true });
      const ev = {
        callId: "c",
        channelId,
        callerId: sender._id.toString(),
        callerName: "x",
        calleeIds: [recipient._id.toString()],
        expiresAt: Date.now() + 45_000,
      };
      await service.onCallRinging(ev);
      expect(await PushTokenModel.countDocuments()).toBe(0);
      fakeFcm.isConfigured = false;
      fakeFcm.sendData.mockClear();
      await service.onCallRinging(ev);
      expect(fakeFcm.sendData).not.toHaveBeenCalled();
    });
  });
});
