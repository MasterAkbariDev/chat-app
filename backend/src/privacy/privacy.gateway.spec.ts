import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Contact, ContactSchema } from "src/contacts/schema/contact.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { ChatType, UserRole, UserStatus } from "src/enum/base.enum";
import { PrivacyService } from "./privacy.service";
import type { ChatGateway as ChatGatewayT } from "src/gateway/chat.gateway";

type Emit = { target: string | string[]; event: string; payload: unknown };

/** The realtime side: presence fan-out and per-recipient photo stripping on message events. */
describe("ChatGateway privacy (presence + message broadcasts)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let ContactModel: Model<Contact>;
  let ChatModel: Model<Chat>;
  let MembersModel: Model<ChatMembers>;
  let privacy: PrivacyService;
  let gateway: ChatGatewayT;
  let emits: Emit[];
  let rooms: Map<string, Set<string>>;
  let seq = 0;

  beforeAll(async () => {
    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    ContactModel = connection.model(Contact.name, ContactSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    MembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    privacy = new PrivacyService(UserModel, ContactModel);
    const { ChatGateway } = await import("src/gateway/chat.gateway");
    gateway = new ChatGateway(
      {} as never,
      {} as never,
      {} as never,
      { isBlocked: () => Promise.resolve(false) } as never,
      {} as never,
      MembersModel,
      ChatModel,
      UserModel,
      {} as never,
      { error: jest.fn(), log: jest.fn() } as never,
      privacy,
    );
  }, 90_000);

  beforeEach(() => {
    emits = [];
    rooms = new Map();
    const target = (t: string | string[]) => ({
      emit: (event: string, payload: unknown) => {
        emits.push({ target: t, event, payload });
        return true;
      },
    });
    gateway.server = {
      adapter: { rooms },
      to: target,
      in: target,
    } as unknown as ChatGatewayT["server"];
  });

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all(
      [UserModel, ContactModel, ChatModel, MembersModel].map(m =>
        (m as Model<unknown>).deleteMany({}),
      ),
    );
  });

  const mk = () =>
    UserModel.create({
      username: `gw${++seq}x`,
      email: `gw${seq}@example.com`,
      password: "hashed",
      image: [`/uploads/media/gw${seq}.jpg`],
    });
  const id = (u: { _id: Types.ObjectId }) => u._id.toString();
  async function chatWith(type: ChatType, members: { _id: Types.ObjectId }[]) {
    const chat = await ChatModel.create({
      type,
      link: `c-${++seq}`,
      name: "c",
    });
    await MembersModel.insertMany(
      members.map(m => ({
        channelId: String(chat._id),
        userId: id(m),
        role: UserRole.MEMBER,
      })),
    );
    return String(chat._id);
  }
  const presence = (userId: string) =>
    (
      gateway as unknown as {
        broadcastPresence: (u: string, p: object) => Promise<void>;
      }
    ).broadcastPresence(userId, { userId, status: UserStatus.ONLINE });

  it("presence reaches only co-members allowed to see it, both ways; never channel subscribers", async () => {
    const me = await mk();
    const [friend, stranger, hider, subscriber] = await Promise.all([
      mk(),
      mk(),
      mk(),
      mk(),
    ]);
    await chatWith(ChatType.GROUP, [me, friend, stranger, hider]);
    await chatWith(ChatType.CHANNEL, [me, subscriber]);
    await ContactModel.create({ ownerId: id(me), userId: id(friend) });
    await privacy.updateSettings(id(me), { lastSeen: "contacts" });
    await privacy.updateSettings(id(hider), { lastSeen: "nobody" });
    await presence(id(me));
    expect(emits).toHaveLength(1);
    expect(emits[0].event).toBe("user_status_changed");
    expect(emits[0].target).toEqual([`user:${id(friend)}`]);

    // The hider is a contact too, but hides their own → still nothing (reciprocity).
    emits.length = 0;
    await ContactModel.create({ ownerId: id(me), userId: id(hider) });
    await presence(id(me));
    expect(emits[0].target).toEqual([`user:${id(friend)}`]);

    // "Never allow" removes the friend; nobody left → no emit at all.
    emits.length = 0;
    await privacy.updateSettings(id(me), { lastSeen: { deny: [id(friend)] } });
    await presence(id(me));
    expect(emits).toEqual([]);
  });

  it("message events strip the sender's photo per recipient only when needed", async () => {
    const sender = await mk();
    const [allowed, hiddenFrom] = await Promise.all([mk(), mk()]);
    const channelId = await chatWith(ChatType.GROUP, [
      sender,
      allowed,
      hiddenFrom,
    ]);
    const room = `channel:${channelId}`;
    rooms.set(room, new Set(["s1", "s2", "s3"]));
    const socketUsers = (
      gateway as unknown as { socketUsers: Map<string, string> }
    ).socketUsers;
    socketUsers.set("s1", id(sender));
    socketUsers.set("s2", id(allowed));
    socketUsers.set("s3", id(hiddenFrom));
    const message = {
      _id: "m1",
      senderId: { _id: id(sender), avatarUrl: sender.image, firstName: "S" },
    };

    // Default (everybody): a single room emit.
    gateway.broadcastNewMessage(channelId, message);
    await new Promise(r => setTimeout(r, 50));
    expect(emits).toHaveLength(1);
    expect(emits[0].target).toBe(room);

    emits.length = 0;
    await privacy.updateSettings(id(sender), {
      profilePhotos: { audience: "everybody", deny: [id(hiddenFrom)] },
    });
    gateway.broadcastNewMessage(channelId, message);
    await new Promise(r => setTimeout(r, 50));
    const bySocket = new Map(emits.map(e => [e.target as string, e.payload]));
    const photoOf = (s: string) =>
      (bySocket.get(s) as { message: { senderId: { avatarUrl: string[] } } })
        .message.senderId.avatarUrl;
    expect(photoOf("s1")).toEqual(sender.image);
    expect(photoOf("s2")).toEqual(sender.image);
    expect(photoOf("s3")).toEqual([]);
  });
});
