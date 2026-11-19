import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { BadRequestException } from "@nestjs/common";
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
import { ChatType, MessageType, UserRole } from "src/enum/base.enum";
import { MessageService } from "./message.service";
import type { EventEmitter2 } from "eventemitter2";
import { privacyServiceFor } from "src/common/testing/privacy";
import type { SharedMediaKind } from "./shared-media.util";

/** Shared media counts and lists are per ITEM (attachment), not per message. */
describe("MessageService shared media items", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MessageModel: Model<Message>;
  let ChatMembersModel: Model<ChatMembers>;
  let service: MessageService;
  let channelId: string;
  let me: string;
  let other: string;
  let t = Date.UTC(2026, 0, 1);

  /** Messages are created oldest → newest, one second apart (unless `at` is given). */
  async function send(fields: Partial<Message> & { at?: number }) {
    const { at, ...rest } = fields;
    const createdAt = new Date(at ?? (t += 1000));
    const doc = await MessageModel.create({
      channelId,
      senderId: new Types.ObjectId(other),
      content: "",
      ...rest,
    });
    // `timestamps` sets createdAt itself; pin it so ordering is deterministic.
    await MessageModel.collection.updateOne(
      { _id: doc._id },
      { $set: { createdAt } },
    );
    return String(doc._id);
  }

  const meta = (kind?: "file" | "audio" | "video", fileName?: string) => ({
    mediaId: String(new Types.ObjectId()),
    width: 10,
    height: 10,
    blurhash: null,
    ...(kind ? { kind } : {}),
    ...(fileName ? { fileName } : {}),
  });

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    MessageModel = connection.model(Message.name, MessageSchema);
    const MessageReactionModel = connection.model(
      MessageReaction.name,
      MessageReactionSchema,
    );
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    const ChatModel = connection.model(Chat.name, ChatSchema);
    const UserModel = connection.model(User.name, UserSchema);
    service = new MessageService(
      MessageModel,
      MessageReactionModel,
      ChatMembersModel,
      ChatModel,
      UserModel,
      {} as never,
      { emit: jest.fn() } as unknown as EventEmitter2,
      {} as never,
      privacyServiceFor(connection),
    );

    const a = await UserModel.create({ username: "maya_s", password: "x" });
    const b = await UserModel.create({ username: "omid_s", password: "x" });
    me = String(a._id);
    other = String(b._id);
    const chat = await ChatModel.create({
      link: "shared-items",
      type: ChatType.PRIVATE,
    });
    channelId = String(chat._id);
    await ChatMembersModel.create([
      { channelId, userId: me, role: UserRole.MEMBER },
      { channelId, userId: other, role: UserRole.MEMBER },
    ]);

    // Before "clear history" (hidden for me later).
    ids.cleared = await send({
      type: MessageType.IMAGE,
      attachments: ["/c1.jpg", "/c2.jpg"],
    });
    t += 60_000;
    ids.photo = await send({
      type: MessageType.IMAGE,
      attachments: ["/p.jpg"],
    });
    // A mixed album: 2 photos + a video = 3 media items.
    ids.album = await send({
      type: MessageType.IMAGE,
      attachments: ["/a1.jpg", "/a2.mp4", "/a3.jpg"],
      attachmentMeta: {
        "/a1.jpg": meta(),
        "/a2.mp4": meta("video"),
        "/a3.jpg": meta(),
      },
    });
    ids.video = await send({
      type: MessageType.VIDEO,
      attachments: ["/v.mp4"],
    });
    // A file group: 2 documents + an mp3 sent as a file (music).
    ids.fileGroup = await send({
      type: MessageType.FILE,
      attachments: [
        "/media/f1/original",
        "/media/f2/original",
        "/media/f3/original",
      ],
      originalFilename: "report.pdf",
      attachmentMeta: {
        "/media/f1/original": meta("file", "report.pdf"),
        "/media/f2/original": meta("file", "notes.docx"),
        "/media/f3/original": meta("audio", "song.mp3"),
      },
    });
    ids.legacySong = await send({
      type: MessageType.FILE,
      attachments: ["/uploads/old.m4a"],
    });
    // A music group of 3 tracks.
    ids.tracks = await send({
      type: MessageType.AUDIO,
      attachments: ["/t1", "/t2", "/t3"],
    });
    ids.voice = await send({
      type: MessageType.VOICE,
      attachments: ["/v.ogg"],
      durationSec: 3,
    });
    ids.round = await send({
      type: MessageType.VIDEO_NOTE,
      attachments: ["/r.mp4"],
    });
    ids.link = await send({
      type: MessageType.TEXT,
      content: "look https://example.com/a and https://example.org/b",
    });
    ids.text = await send({ type: MessageType.TEXT, content: "plain" });
    ids.gif = await send({ type: MessageType.GIF, attachments: ["/g.mp4"] });
    ids.sticker = await send({
      type: MessageType.STICKER,
      attachments: ["/s.webp"],
    });
    ids.deleted = await send({
      type: MessageType.IMAGE,
      attachments: ["/d.jpg"],
      isDeleted: true,
    });
    ids.deletedForMe = await send({
      type: MessageType.IMAGE,
      attachments: ["/dm.jpg"],
      deletedFor: [new Types.ObjectId(me)],
    });

    const cleared = await MessageModel.findById(ids.cleared).lean();
    await ChatMembersModel.updateOne(
      { channelId, userId: me },
      { $set: { hiddenAt: new Date(cleared!.createdAt.getTime() + 1) } },
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  it("counts attachments, not messages", async () => {
    expect(await service.getSharedCounts(channelId, me)).toEqual({
      media: 5, // photo + album(3) + video
      files: 2, // the file group's two documents
      music: 5, // the group's mp3 + legacy m4a + 3 tracks
      voice: 2,
      links: 1, // one message, however many links it has
      gifs: 1,
    });
  });

  it("still sees cleared history for the other member", async () => {
    const counts = await service.getSharedCounts(channelId, other);
    expect(counts.media).toBe(7 + 1); // + the 2 cleared photos and the one deleted only for me
  });

  async function all(kind: SharedMediaKind, limit: number) {
    const out: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.getSharedItems(
        channelId,
        me,
        kind,
        cursor,
        limit,
      );
      pages++;
      // Every ref's message comes back, once.
      const msgIds = page.messages.map(m => String(m._id));
      expect(new Set(msgIds).size).toBe(msgIds.length);
      for (const it of page.items) {
        expect(msgIds).toContain(it.messageId);
        out.push(`${it.messageId}:${it.index}`);
      }
      cursor = page.nextCursor ?? undefined;
      expect(pages).toBeLessThan(20);
    } while (cursor);
    return out;
  }

  it("lists media items newest first, an album's items in order, across pages", async () => {
    const expected = [
      `${ids.video}:0`,
      `${ids.album}:0`,
      `${ids.album}:1`,
      `${ids.album}:2`,
      `${ids.photo}:0`,
    ];
    expect(await all("media", 100)).toEqual(expected);
    // Pages that split the album still return each item exactly once.
    expect(await all("media", 2)).toEqual(expected);
    expect(await all("media", 1)).toEqual(expected);
  });

  it("splits a file group between Files and Music", async () => {
    expect(await all("files", 1)).toEqual([
      `${ids.fileGroup}:0`,
      `${ids.fileGroup}:1`,
    ]);
    expect(await all("music", 2)).toEqual([
      `${ids.tracks}:0`,
      `${ids.tracks}:1`,
      `${ids.tracks}:2`,
      `${ids.legacySong}:0`,
      `${ids.fileGroup}:2`,
    ]);
  });

  it("lists voice, links and GIFs", async () => {
    expect(await all("voice", 10)).toEqual([
      `${ids.round}:0`,
      `${ids.voice}:0`,
    ]);
    expect(await all("links", 10)).toEqual([`${ids.link}:0`]);
    expect(await all("gifs", 10)).toEqual([`${ids.gif}:0`]);
  });

  it("pages messages that share a timestamp without skipping any", async () => {
    const at = Date.UTC(2027, 0, 1);
    const same = [
      await send({ type: MessageType.GIF, attachments: ["/x1.mp4"], at }),
      await send({ type: MessageType.GIF, attachments: ["/x2.mp4"], at }),
      await send({ type: MessageType.GIF, attachments: ["/x3.mp4"], at }),
    ];
    const got = await all("gifs", 1);
    expect(got).toHaveLength(4);
    expect(got.slice(0, 3).sort()).toEqual(same.map(id => `${id}:0`).sort());
    expect(got[3]).toBe(`${ids.gif}:0`);
  });

  it("rejects a malformed cursor", async () => {
    await expect(
      service.getSharedItems(channelId, me, "media", "nope", 10),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("maps senders and returns full messages for rendering", async () => {
    const page = await service.getSharedItems(
      channelId,
      me,
      "files",
      undefined,
      10,
    );
    expect(page.messages).toHaveLength(1);
    const m = page.messages[0] as unknown as {
      senderId: { username: string };
      attachmentMeta: Record<string, { fileName?: string }>;
    };
    expect(m.senderId.username).toBe("omid_s");
    expect(m.attachmentMeta["/media/f2/original"].fileName).toBe("notes.docx");
    expect(page.nextCursor).toBeNull();
  });
});
