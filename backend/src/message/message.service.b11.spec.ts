import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { Message, MessageSchema } from "./schema/message.schema";
import {
  MessageReaction,
  MessageReactionSchema,
} from "./schema/message-reaction.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { User, UserSchema } from "src/user/schema/user.schema";
import { ChatType, UserRole } from "src/enum/base.enum";
import { MessageService } from "./message.service";
import { QueryCounter } from "src/common/testing/query-counter";
import type { EventEmitter2 } from "eventemitter2";
import { privacyServiceFor } from "src/common/testing/privacy";

/**
 * Perf budget (B11, docs/plans/BACKEND_PLAN.md — "perf budgets in CI: query counts"). B5's
 * `create()` rewrite parallelised 3 independent pre-checks into one round trip but explicitly
 * did NOT collapse them to fewer than 3 queries (documented as a known gap, judged too wide a
 * blast radius for that pass). This test guards the number actually achieved — 3, not the
 * plan's aspirational "≤3" ideal — so a future change that accidentally adds a 4th query (or a
 * refactor that finally removes one) is a visible, deliberate diff here, not a silent regression.
 */
describe("MessageService.create (B11 perf budget: 3 queries per send)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatMembersModel: Model<ChatMembers>;
  let ChatModel: Model<Chat>;
  let UserModel: Model<User>;
  let service: MessageService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    const MessageModel = connection.model(Message.name, MessageSchema);
    const MessageReactionModel = connection.model(
      MessageReaction.name,
      MessageReactionSchema,
    );
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    UserModel = connection.model(User.name, UserSchema);

    const fakeEmitter = { emit: jest.fn() } as unknown as EventEmitter2;
    const fakePacksService = {
      resolveItemForUse: jest.fn(() => {
        throw new Error(
          "resolveItemForUse should not be called from these tests",
        );
      }),
    } as unknown as import("src/packs/packs.service").PacksService;
    // None of these tests send an attachment with attachmentMediaIds, so
    // buildAttachmentMeta's `MediaAsset.find` short-circuits before ever
    // reaching this model — a stub that throws if invoked is enough to
    // catch that assumption breaking silently.
    const fakeMediaAssetModel = {
      find: jest.fn(() => {
        throw new Error(
          "MediaAsset.find should not be called from these tests",
        );
      }),
    } as unknown as import("mongoose").Model<
      import("src/media/schema/media-asset.schema").MediaAsset
    >;
    service = new MessageService(
      MessageModel,
      MessageReactionModel,
      ChatMembersModel,
      ChatModel,
      UserModel,
      fakeMediaAssetModel,
      fakeEmitter,
      fakePacksService,
      privacyServiceFor(connection),
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  it("sends a plain text message in exactly 3 queries", async () => {
    const user = await UserModel.create({ username: "perf1", password: "x" });
    const chat = await ChatModel.create({
      link: "perf-chat",
      type: ChatType.GROUP,
      name: "Perf",
    });
    await ChatMembersModel.create({
      channelId: chat._id.toString(),
      userId: user._id.toString(),
      role: UserRole.OWNER,
    });

    const counter = new QueryCounter();
    counter.start();
    await service.create(
      { channelId: chat._id.toString(), content: "hello" },
      user._id.toString(),
    );
    expect(counter.stop()).toBe(3);
  });
});
