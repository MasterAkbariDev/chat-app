import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Message, MessageSchema } from "./message.schema";
import { MessageType } from "src/enum/base.enum";

describe("Message (B0: new indexes)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MessageModel: Model<Message>;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    MessageModel = connection.model(Message.name, MessageSchema);
    await MessageModel.createIndexes();
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  it("channel history filtered by isDeleted uses IXSCAN (not COLLSCAN)", async () => {
    const channelId = "chan-1";
    await MessageModel.create({
      channelId,
      senderId: new Types.ObjectId(),
      content: "hi",
      isDeleted: false,
    });

    const explanation = await MessageModel.find({ channelId, isDeleted: false })
      .sort({ createdAt: -1 })
      .explain("executionStats");

    const stagesUsed = collectStages(explanation);
    expect(stagesUsed).toContain("IXSCAN");
    expect(stagesUsed).not.toContain("COLLSCAN");
  });

  it("channel media gallery filtered by type uses IXSCAN (not COLLSCAN)", async () => {
    const channelId = "chan-2";
    await MessageModel.create({
      channelId,
      senderId: new Types.ObjectId(),
      attachments: ["/uploads/a.jpg"],
      type: MessageType.IMAGE,
    });

    const explanation = await MessageModel.find({
      channelId,
      type: MessageType.IMAGE,
    })
      .sort({ createdAt: -1 })
      .explain("executionStats");

    const stagesUsed = collectStages(explanation);
    expect(stagesUsed).toContain("IXSCAN");
    expect(stagesUsed).not.toContain("COLLSCAN");
  });
});

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
