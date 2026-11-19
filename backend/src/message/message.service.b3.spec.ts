import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
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
import { UserRole } from "src/enum/base.enum";
import type { MessageService as MessageServiceType } from "./message.service";
import type { EventEmitter2 } from "eventemitter2";
import { privacyServiceFor } from "src/common/testing/privacy";

describe("MessageService.findSinceMessage (B3: reconnect resync)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MessageModel: Model<Message>;
  let MessageReactionModel: Model<MessageReaction>;
  let ChatMembersModel: Model<ChatMembers>;
  let ChatModel: Model<Chat>;
  let UserModel: Model<User>;
  let service: MessageServiceType;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    MessageModel = connection.model(Message.name, MessageSchema);
    MessageReactionModel = connection.model(
      MessageReaction.name,
      MessageReactionSchema,
    );
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    UserModel = connection.model(User.name, UserSchema);

    const { MessageService } = await import("./message.service");
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

  it("returns only messages newer than the anchor, oldest first", async () => {
    const channelId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();
    const senderId = new Types.ObjectId();
    await ChatMembersModel.create({ channelId, userId, role: UserRole.MEMBER });

    const anchor = await MessageModel.create({
      channelId,
      senderId,
      content: "anchor",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    await MessageModel.create({
      channelId,
      senderId,
      content: "missed 1",
      createdAt: new Date("2024-01-02T00:00:00.000Z"),
    });
    await MessageModel.create({
      channelId,
      senderId,
      content: "missed 2",
      createdAt: new Date("2024-01-03T00:00:00.000Z"),
    });

    const result = await service.findSinceMessage(
      channelId,
      userId,
      anchor._id.toString(),
    );

    expect(result.map(m => m.content)).toEqual(["missed 1", "missed 2"]);
  });

  it("rejects a non-member", async () => {
    const channelId = new Types.ObjectId().toString();
    const senderId = new Types.ObjectId();
    const anchor = await MessageModel.create({
      channelId,
      senderId,
      content: "anchor",
    });

    await expect(
      service.findSinceMessage(
        channelId,
        new Types.ObjectId().toString(),
        anchor._id.toString(),
      ),
    ).rejects.toThrow(/access denied/i);
  });
});
