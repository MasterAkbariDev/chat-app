import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { ChatMembers, ChatMembersSchema } from "./chat-members.schema";
import { UserRole } from "src/enum/base.enum";
import { QueryCounter } from "src/common/testing/query-counter";

describe("ChatMembers (B0: indexes + query count)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatMembersModel: Model<ChatMembers>;

  beforeAll(async () => {
    // Generous launchTimeout: under a sandboxed/CI runner, spawning the mongod child
    // process can be much slower than on a bare host — the library's own default (10s)
    // is too tight there even though startup itself only takes ~1s normally.
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    // Indexes are created in the background by default — wait for them so explain() sees them.
    await ChatMembersModel.createIndexes();
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  it("unique index rejects a duplicate (channelId, userId) pair", async () => {
    await ChatMembersModel.create({
      channelId: "chan-1",
      userId: "user-1",
      role: UserRole.MEMBER,
    });

    await expect(
      ChatMembersModel.create({
        channelId: "chan-1",
        userId: "user-1",
        role: UserRole.ADMIN,
      }),
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  it("membership lookup (channelId, userId) uses the index (IXSCAN, not COLLSCAN)", async () => {
    await ChatMembersModel.create({
      channelId: "chan-2",
      userId: "user-2",
      role: UserRole.MEMBER,
    });

    const explanation = await ChatMembersModel.findOne({
      channelId: "chan-2",
      userId: "user-2",
    })
      .explain("executionStats")
      .exec();

    const stagesUsed = collectStages(explanation);
    expect(stagesUsed).toContain("IXSCAN");
    expect(stagesUsed).not.toContain("COLLSCAN");
  });

  it("membership lookup is exactly one query", async () => {
    await ChatMembersModel.create({
      channelId: "chan-3",
      userId: "user-3",
      role: UserRole.MEMBER,
    });

    const counter = new QueryCounter();
    counter.start();
    await ChatMembersModel.findOne({
      channelId: "chan-3",
      userId: "user-3",
    }).exec();
    const count = counter.stop();

    expect(count).toBe(1);
  });
});

/** Collects every `stage` name across an explain() output's nested execution plan tree. */
function collectStages(explanation: unknown): string[] {
  const stages: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.stage === "string") stages.push(obj.stage);
    if (Array.isArray(obj.shards)) obj.shards.forEach(visit);
    if (obj.queryPlanner) visit(obj.queryPlanner);
    if (obj.winningPlan) visit(obj.winningPlan);
    if (obj.executionStats) visit(obj.executionStats);
    if (obj.executionStages) visit(obj.executionStages);
    if (obj.inputStage) visit(obj.inputStage);
    if (Array.isArray(obj.inputStages)) obj.inputStages.forEach(visit);
  };
  visit(explanation);
  return stages;
}
