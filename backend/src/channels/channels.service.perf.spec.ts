import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { ChatState, ChatStateSchema } from "src/chat/schema/chat-state.schema";
import { ChannelsService } from "./channels.service";
import { ChatType, UserRole } from "src/enum/base.enum";
import { QueryCounter } from "src/common/testing/query-counter";
import type { FoldersService } from "src/folders/folders.service";
import { privacyServiceFor } from "src/common/testing/privacy";

/**
 * Perf budget (B11, docs/plans/BACKEND_PLAN.md — "perf budgets in CI: query counts"). The whole
 * point of B2's `GET /v1/channels/mine` rewrite was collapsing an N+1 (one query per DM to find
 * the other member) into a single aggregation — this test is a regression guard for that, not a
 * new claim: it fails loudly if a future change quietly reintroduces a second query per channel.
 */
describe("ChannelsService.listMine (B11 perf budget: stays at 1 query regardless of channel count)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatModel: Model<Chat>;
  let ChatMembersModel: Model<ChatMembers>;
  let service: ChannelsService;
  let fakeFoldersService: FoldersService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ChatModel = connection.model(Chat.name, ChatSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    connection.model(ChatState.name, ChatStateSchema);

    fakeFoldersService = {
      getOwnedFolder: jest.fn(),
    } as unknown as FoldersService;
    service = new ChannelsService(
      ChatMembersModel,
      fakeFoldersService,
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

  it("issues exactly one query for 20 channels, same as for 1", async () => {
    const userId = new Types.ObjectId().toString();

    const makeChannel = async () => {
      const chat = await ChatModel.create({
        link: `chan_${Math.random()}`,
        type: ChatType.GROUP,
        name: "Group",
      });
      await ChatMembersModel.create({
        channelId: chat._id.toString(),
        userId,
        role: UserRole.MEMBER,
      });
    };

    await makeChannel();
    const counter = new QueryCounter();
    counter.start();
    await service.listMine(userId, {});
    const queriesForOne = counter.stop();

    for (let i = 0; i < 19; i++) await makeChannel();
    counter.start();
    await service.listMine(userId, {});
    const queriesForTwenty = counter.stop();

    expect(queriesForOne).toBe(1);
    expect(queriesForTwenty).toBe(queriesForOne);
  });
});
