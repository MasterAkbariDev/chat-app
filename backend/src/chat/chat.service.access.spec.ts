import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Chat, ChatSchema } from "./schema/chat.schema";
import { ChatMembers, ChatMembersSchema } from "./schema/chat-members.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import type { ChatGateway } from "src/gateway/chat.gateway";
import type { ChatService as ChatServiceType } from "./chat.service";
import type { EventEmitter2 } from "eventemitter2";
import { ChatType, UserRole } from "src/enum/base.enum";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("ChatService (visibility, invites, admins)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatModel: Model<Chat>;
  let ChatMembersModel: Model<ChatMembers>;
  let UserModel: Model<User>;
  let MessageModel: Model<Message>;
  let service: ChatServiceType;

  const fakeGateway = {
    notifyNewChat: jest.fn().mockResolvedValue(undefined),
    notifyChatBanned: jest.fn(),
    notifyChannelRolesUpdated: jest.fn(),
    notifyUserMuted: jest.fn(),
    notifyChatUpdated: jest.fn(),
    notifyPermissionsUpdated: jest.fn(),
  } as unknown as ChatGateway;
  const fakeEventEmitter = { emit: jest.fn() } as unknown as EventEmitter2;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ChatModel = connection.model(Chat.name, ChatSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    UserModel = connection.model(User.name, UserSchema);
    MessageModel = connection.model(Message.name, MessageSchema);

    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";
    const { ChatService } = await import("./chat.service");

    service = new ChatService(
      ChatModel,
      ChatMembersModel,
      UserModel,
      MessageModel,
      fakeGateway,
      fakeEventEmitter,
      privacyServiceFor(connection),
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all([
      ChatModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
    ]);
  });

  const id = () => new Types.ObjectId().toString();
  async function makeChat(
    type: ChatType,
    isPublic: boolean,
    ownerId: string,
    extra: Record<string, string> = {},
  ) {
    const chat = await ChatModel.create({
      link: `c-${id()}`,
      type,
      name: "Chat",
      isPublic,
      inviteCode: `inv${id()}`,
    });
    const channelId = chat._id.toString();
    await ChatMembersModel.create({
      channelId,
      userId: ownerId,
      role: UserRole.OWNER,
    });
    for (const [userId, role] of Object.entries(extra)) {
      await ChatMembersModel.create({ channelId, userId, role });
    }
    return chat;
  }

  describe("subscribe / preview", () => {
    it("lets anyone join a public group, but a private one only by invite", async () => {
      const owner = id();
      const stranger = id();
      const pub = await makeChat(ChatType.GROUP, true, owner);
      const priv = await makeChat(ChatType.GROUP, false, owner);

      await service.subscribe(pub._id.toString(), stranger);
      expect(
        await ChatMembersModel.exists({
          channelId: pub._id.toString(),
          userId: stranger,
        }),
      ).toBeTruthy();

      await expect(
        service.subscribe(priv._id.toString(), stranger),
      ).rejects.toThrow();
      const { channelId } = await service.joinByInvite(
        priv.inviteCode!,
        stranger,
      );
      expect(channelId).toBe(priv._id.toString());
    });

    it("refuses to join someone else's direct chat by id", async () => {
      const dm = await makeChat(ChatType.PRIVATE, false, id());
      await expect(
        service.subscribe(dm._id.toString(), id()),
      ).rejects.toThrow();
    });

    it("previews a public chat without joining, and hides a private one", async () => {
      const owner = id();
      const stranger = id();
      const pub = await makeChat(ChatType.CHANNEL, true, owner);
      const priv = await makeChat(ChatType.CHANNEL, false, owner);

      const preview = await service.findChatByIdForPreview(
        pub._id.toString(),
        stranger,
      );
      expect(preview).toMatchObject({ isMember: false, memberCount: 1 });
      expect(
        await ChatMembersModel.exists({
          channelId: pub._id.toString(),
          userId: stranger,
        }),
      ).toBeNull();

      await expect(
        service.findChatByIdForPreview(priv._id.toString(), stranger),
      ).rejects.toThrow();
    });
  });

  describe("invite codes", () => {
    it("are owner/admin only, and resetting invalidates the old code", async () => {
      const owner = id();
      const admin = id();
      const member = id();
      const chat = await makeChat(ChatType.GROUP, false, owner, {
        [admin]: UserRole.ADMIN,
        [member]: UserRole.MEMBER,
      });
      const channelId = chat._id.toString();

      await expect(service.getInviteCode(channelId, member)).rejects.toThrow();
      const { inviteCode: first } = await service.getInviteCode(
        channelId,
        admin,
      );
      const { inviteCode: second } = await service.getInviteCode(
        channelId,
        owner,
        true,
      );
      expect(second).not.toBe(first);
      await expect(service.joinByInvite(first, id())).rejects.toThrow();
    });
  });

  describe("admins and bans", () => {
    it("only the owner can promote, and nobody can ban the owner", async () => {
      const owner = id();
      const admin = id();
      const member = id();
      const chat = await makeChat(ChatType.GROUP, true, owner, {
        [admin]: UserRole.ADMIN,
        [member]: UserRole.MEMBER,
      });
      const channelId = chat._id.toString();

      await expect(
        service.setAdmin(channelId, member, admin, true),
      ).rejects.toThrow();
      await expect(
        service.setAdmin(channelId, member, owner, true),
      ).resolves.toMatchObject({ role: UserRole.ADMIN });
      await expect(
        service.setBanned(channelId, owner, admin, true),
      ).rejects.toThrow();
      await expect(
        service.setBanned(channelId, member, admin, true),
      ).rejects.toThrow(); // member is an admin now
    });
  });

  describe("update", () => {
    it("lets admins rename but not change visibility", async () => {
      const owner = id();
      const admin = id();
      const chat = await makeChat(ChatType.GROUP, false, owner, {
        [admin]: UserRole.ADMIN,
      });
      const channelId = chat._id.toString();

      await service.update(channelId, { name: "Renamed" }, admin);
      expect((await ChatModel.findById(channelId))?.name).toBe("Renamed");
      await expect(
        service.update(channelId, { isPublic: true }, admin),
      ).rejects.toThrow();
      await expect(
        service.update(channelId, { name: "x" }, id()),
      ).rejects.toThrow();
    });
  });

  describe("admin rights", () => {
    it("lets an admin with 'add admins' promote with a subset of their own rights only", async () => {
      const owner = id();
      const lead = id();
      const member = id();
      const other = id();
      const chat = await makeChat(ChatType.GROUP, true, owner, {
        [lead]: UserRole.MEMBER,
        [member]: UserRole.MEMBER,
        [other]: UserRole.MEMBER,
      });
      const channelId = chat._id.toString();

      await service.setAdminRights(channelId, lead, owner, {
        addAdmins: true,
        banUsers: false,
      });
      // lead can't grant banUsers (doesn't have it)…
      await expect(
        service.setAdminRights(channelId, member, lead, { banUsers: true }),
      ).rejects.toThrow(/don't have/);
      // …but can grant what they hold.
      await expect(
        service.setAdminRights(channelId, member, lead, {
          banUsers: false,
          addAdmins: false,
        }),
      ).resolves.toMatchObject({ role: UserRole.ADMIN });
      // An admin the owner appointed is out of lead's reach.
      await service.setAdminRights(channelId, other, owner, {});
      await expect(
        service.setAdminRights(channelId, other, lead, null),
      ).rejects.toThrow(/appointed/);
      // Demote back.
      await expect(
        service.setAdminRights(channelId, member, lead, null),
      ).resolves.toMatchObject({ role: UserRole.MEMBER });
    });

    it("keeps rights the editor lacks when they edit an admin they appointed", async () => {
      const owner = id();
      const lead = id();
      const member = id();
      const chat = await makeChat(ChatType.GROUP, true, owner, {
        [lead]: UserRole.MEMBER,
        [member]: UserRole.MEMBER,
      });
      const channelId = chat._id.toString();

      await service.setAdminRights(channelId, lead, owner, {
        addAdmins: true,
        banUsers: false,
      });
      // Promoting without naming banUsers just leaves it off rather than failing.
      const promoted = await service.setAdminRights(
        channelId,
        member,
        lead,
        {},
      );
      expect(promoted.adminRights?.banUsers).toBe(false);
      // The owner then gives member banUsers; lead can still edit member's other rights…
      await service.setAdminRights(channelId, member, owner, {
        banUsers: true,
      });
      const edited = await service.setAdminRights(channelId, member, lead, {
        pinMessages: false,
        banUsers: false,
      });
      // …and banUsers, which lead can't touch, stays as the owner set it.
      expect(edited.adminRights).toMatchObject({
        pinMessages: false,
        banUsers: true,
      });
    });
  });

  describe("member permissions", () => {
    it("needs 'ban users', and exceptions override the defaults", async () => {
      const owner = id();
      const member = id();
      const chat = await makeChat(ChatType.GROUP, false, owner, {
        [member]: UserRole.MEMBER,
      });
      const channelId = chat._id.toString();

      await expect(
        service.setDefaultPermissions(channelId, member, {
          sendStickers: false,
        }),
      ).rejects.toThrow();
      await service.setDefaultPermissions(channelId, owner, {
        sendStickers: false,
      });
      expect(
        (await service.getPermissions(channelId, member)).myPermissions.member
          .sendStickers,
      ).toBe(false);

      await service.setMemberPermissions(channelId, member, owner, {
        sendStickers: true,
        sendMessages: false,
      });
      const p = (await service.getPermissions(channelId, member)).myPermissions;
      expect(p.member.sendMessages).toBe(false);
      expect(
        (await ChatMembersModel.findOne({ channelId, userId: member }))
          ?.mutedByAdmin,
      ).toBe(true);

      await service.setMemberPermissions(channelId, member, owner, null);
      expect(
        (await service.getPermissions(channelId, member)).myPermissions.member
          .sendMessages,
      ).toBe(true);
    });
  });
});
