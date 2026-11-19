import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { Message, MessageSchema } from "./schema/message.schema";
import { MessageType } from "src/enum/base.enum";
import {
  isSharedMediaKind,
  SHARED_MEDIA_KINDS,
  sharedKindFilter,
} from "./shared-media.util";

describe("shared media filters", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MessageModel: Model<Message>;
  const channelId = "chan-shared";

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    MessageModel = connection.model(Message.name, MessageSchema);
    const senderId = new Types.ObjectId();
    const base = { channelId, senderId };
    await MessageModel.create([
      {
        ...base,
        content: "photo",
        type: MessageType.IMAGE,
        attachments: ["/uploads/a.jpg"],
      },
      {
        ...base,
        content: "clip",
        type: MessageType.VIDEO,
        attachments: ["/uploads/a.mp4"],
      },
      {
        ...base,
        content: "gif",
        type: MessageType.GIF,
        attachments: ["/g.gif"],
      },
      {
        ...base,
        content: "doc",
        type: MessageType.FILE,
        attachments: ["/uploads/media/x/original"],
        originalFilename: "report.pdf",
      },
      {
        ...base,
        content: "song",
        type: MessageType.FILE,
        attachments: ["/uploads/media/y/original"],
        originalFilename: "Song.MP3",
      },
      {
        ...base,
        content: "legacy song",
        type: MessageType.FILE,
        attachments: ["/uploads/abc.m4a"],
      },
      { ...base, content: "see https://example.com/x", type: MessageType.TEXT },
      { ...base, content: "www.example.org", type: MessageType.TEXT },
      { ...base, content: "plain text", type: MessageType.TEXT },
      {
        ...base,
        content: "hi",
        type: MessageType.VOICE,
        attachments: ["/v.ogg"],
      },
      {
        ...base,
        content: "round",
        type: MessageType.VIDEO_NOTE,
        attachments: ["/r.mp4"],
      },
    ]);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  async function contents(kind: (typeof SHARED_MEDIA_KINDS)[number]) {
    const rows = await MessageModel.find({
      channelId,
      ...sharedKindFilter(kind),
    }).lean();
    return rows.map(r => r.content).sort();
  }

  it("sorts each message into exactly the right tab", async () => {
    expect(await contents("media")).toEqual(["clip", "photo"]);
    expect(await contents("files")).toEqual(["doc"]);
    expect(await contents("music")).toEqual(["legacy song", "song"]);
    expect(await contents("links")).toEqual([
      "see https://example.com/x",
      "www.example.org",
    ]);
    expect(await contents("voice")).toEqual(["hi", "round"]);
  });

  it("validates the kind query param", () => {
    expect(isSharedMediaKind("media")).toBe(true);
    expect(isSharedMediaKind("gifs")).toBe(true);
    expect(isSharedMediaKind("groups")).toBe(false);
    expect(isSharedMediaKind(undefined)).toBe(false);
  });
});
