import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MediaAsset,
  MediaAssetSchema,
} from "src/media/schema/media-asset.schema";
import { MediaService } from "src/media/media.service";
import { DiskMediaStorageService } from "src/media/storage/disk-media-storage.service";
import { Clip, ClipSchema } from "./schema/clip.schema";
import { ClipsService } from "./clips.service";
import { GifConversionService } from "./gif-conversion.service";
import { Message, MessageSchema } from "src/message/schema/message.schema";
import {
  ChatMembers,
  ChatMembersSchema,
} from "src/chat/schema/chat-members.schema";
import { Chat, ChatSchema } from "src/chat/schema/chat.schema";
import { Types } from "mongoose";
import { Logger } from "@nestjs/common";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath = require("ffmpeg-static") as string;
const execFileAsync = promisify(execFile);

describe("ClipsService (B9: personal clip library via MediaService)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ClipModel: Model<Clip>;
  let MediaAssetModel: Model<MediaAsset>;
  let MessageModel: Model<Message>;
  let ChatMembersModel: Model<ChatMembers>;
  let ChatModel: Model<Chat>;
  let mediaService: MediaService;
  let service: ClipsService;
  let tempRoot: string;
  let sampleVideoBuffer: Buffer;

  const ownerId = "507f1f77bcf86cd799439011";

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "clips-service-test-"));
    process.env.MEDIA_STORAGE_ROOT = tempRoot;

    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ClipModel = connection.model(Clip.name, ClipSchema);
    MediaAssetModel = connection.model(MediaAsset.name, MediaAssetSchema);
    MessageModel = connection.model(Message.name, MessageSchema);
    ChatMembersModel = connection.model(ChatMembers.name, ChatMembersSchema);
    ChatModel = connection.model(Chat.name, ChatSchema);
    await Promise.all([
      ClipModel.createIndexes(),
      MediaAssetModel.createIndexes(),
    ]);

    mediaService = new MediaService(
      MediaAssetModel,
      new DiskMediaStorageService(),
    );
    service = new ClipsService(
      ClipModel,
      new GifConversionService(),
      mediaService,
      MessageModel,
      ChatMembersModel,
      ChatModel,
      MediaAssetModel,
    );

    // A synthetic 1-second, 320x240 clip generated entirely by ffmpeg's own test-source filter.
    const videoPath = join(tempRoot, "sample-input.mp4");
    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x240:rate=10:duration=1",
        "-pix_fmt",
        "yuv420p",
        videoPath,
      ],
      { timeout: 30_000 },
    );
    sampleVideoBuffer = readFileSync(videoPath);
  }, 120_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.MEDIA_STORAGE_ROOT;
  });

  afterEach(async () => {
    await Promise.all([
      ClipModel.deleteMany({}),
      MediaAssetModel.deleteMany({}),
      MessageModel.deleteMany({}),
      ChatMembersModel.deleteMany({}),
      ChatModel.deleteMany({}),
    ]);
  });

  function makeFile(
    overrides: Partial<Express.Multer.File> = {},
  ): Express.Multer.File {
    return {
      buffer: sampleVideoBuffer,
      originalname: "clip.mp4",
      mimetype: "video/mp4",
      size: sampleVideoBuffer.length,
      ...overrides,
    } as Express.Multer.File;
  }

  it("converts an uploaded video to a GIF and saves it to the library", async () => {
    const item = await service.upload(makeFile(), ownerId, "my clip");

    expect(item.title).toBe("my clip");
    expect(item.relativePath).toMatch(/original\.gif$/);
    expect(item.usageCount).toBe(0);

    const assetCount = await MediaAssetModel.countDocuments({});
    expect(assetCount).toBe(1);
  }, 60_000);

  it("rejects a file that is neither a GIF nor a video (by content)", async () => {
    const text = Buffer.from("just some text, not a video at all");
    await expect(
      service.upload(
        makeFile({ buffer: text, size: text.length, originalname: "x.txt" }),
        ownerId,
      ),
    ).rejects.toThrow(/only gifs and video files/i);
  });

  it("converts a video by its content even when the name has no video extension", async () => {
    const item = await service.upload(
      makeFile({ originalname: "blob" }),
      ownerId,
    );
    expect(item.relativePath).toMatch(/original\.gif$/);
  }, 60_000);

  it("converts an odd-sized, yuv444, with-audio mp4 (the Telegram-export shape) to a GIF", async () => {
    const odd = join(tempRoot, "odd.mp4");
    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=321x241:rate=25:duration=1.5",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1.5",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv444p",
        "-c:a",
        "aac",
        odd,
      ],
      { timeout: 30_000 },
    );
    const buf = readFileSync(odd);
    const item = await service.upload(
      makeFile({ buffer: buf, size: buf.length, originalname: "odd.mp4" }),
      ownerId,
    );
    const asset = await MediaAssetModel.findById(item.mediaId).lean();
    expect(asset?.mimeType).toBe("image/gif");
    expect(asset?.width).toBe(321);
    expect(asset?.height).toBe(241);
  }, 60_000);

  it("stores an uploaded GIF as-is", async () => {
    const gifPath = join(tempRoot, "tiny.gif");
    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=81x45:rate=5:duration=1",
        gifPath,
      ],
      { timeout: 30_000 },
    );
    const buf = readFileSync(gifPath);
    const item = await service.upload(
      makeFile({
        buffer: buf,
        size: buf.length,
        originalname: "tiny.gif",
        mimetype: "image/gif",
      }),
      ownerId,
    );
    const asset = await MediaAssetModel.findById(item.mediaId).lean();
    expect(asset?.sizeBytes).toBe(buf.length);
  }, 60_000);

  it("logs ffmpeg's stderr and the input probe when a video can't be converted", async () => {
    const errors: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation((msg: unknown) => {
        errors.push(String(msg));
      });
    // Valid mp4 signature ("ftyp" box) followed by garbage — sniffs as video, ffmpeg can't read it.
    const broken = Buffer.concat([
      sampleVideoBuffer.subarray(0, 32),
      Buffer.alloc(4096, 7),
    ]);
    try {
      await expect(
        service.upload(
          makeFile({
            buffer: broken,
            size: broken.length,
            originalname: "broken.mp4",
          }),
          ownerId,
        ),
      ).rejects.toThrow(/couldn't be (read|converted)/i);
      expect(errors.join("\n")).toMatch(
        /ffmpeg gif failed — binary=.* stderr: \S+/,
      );
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it("re-uploading the same clip does not create a duplicate library entry", async () => {
    await service.upload(makeFile(), ownerId);
    await service.upload(makeFile(), ownerId);

    const clips = await service.list(ownerId);
    expect(clips).toHaveLength(1);
    const assetCount = await MediaAssetModel.countDocuments({});
    expect(assetCount).toBe(1);
  }, 60_000);

  it("use() bumps usage count and last-used", async () => {
    const item = await service.upload(makeFile(), ownerId);
    await service.use(item.id, ownerId);
    await service.use(item.id, ownerId);

    const [clip] = await service.list(ownerId);
    expect(clip.usageCount).toBe(2);
  }, 60_000);

  it("a different user cannot use or remove someone else's clip", async () => {
    const item = await service.upload(makeFile(), ownerId);
    const stranger = "507f1f77bcf86cd799439099";

    await expect(service.use(item.id, stranger)).rejects.toThrow(
      /only.*your own/i,
    );
    await expect(service.remove(item.id, stranger)).rejects.toThrow(
      /only.*your own/i,
    );
  }, 60_000);

  it("remove() deletes the clip and releases the MediaAsset reference", async () => {
    const item = await service.upload(makeFile(), ownerId);
    const asset = await MediaAssetModel.findById(item.mediaId).exec();
    expect(asset?.refCount).toBe(1);

    await service.remove(item.id, ownerId);

    const clips = await service.list(ownerId);
    expect(clips).toHaveLength(0);
    const releasedAsset = await MediaAssetModel.findById(item.mediaId).exec();
    expect(releasedAsset?.refCount).toBe(0);
  }, 60_000);

  it("rejects a non-video, non-GIF file", async () => {
    await expect(
      service.upload(
        makeFile({ originalname: "x.png", buffer: Buffer.from("nope") }),
        ownerId,
      ),
    ).rejects.toThrow(/only gifs and video files/i);
  });

  async function makeGif(): Promise<Buffer> {
    const gifPath = join(tempRoot, "sample.gif");
    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x48:rate=5:duration=1",
        gifPath,
      ],
      { timeout: 30_000 },
    );
    return readFileSync(gifPath);
  }

  it("stores an uploaded GIF as-is (no conversion)", async () => {
    const gif = await makeGif();
    const item = await service.upload(
      makeFile({ buffer: gif, originalname: "a.gif", mimetype: "image/gif" }),
      ownerId,
    );
    expect(item.relativePath).toMatch(/original\.gif$/);
    const asset = await MediaAssetModel.findById(item.mediaId).exec();
    expect(asset?.sizeBytes).toBe(gif.length);
  }, 60_000);

  describe("saveFromMessage", () => {
    const sender = "507f1f77bcf86cd799439022";

    async function gifMessage(
      opts: { member?: boolean; isPublic?: boolean } = {},
    ) {
      const gif = await makeGif();
      const asset = await mediaService.ingestImage(gif, sender);
      const url = `http://api.test/uploads/media/${asset.variants.original}`;
      const chat = await ChatModel.create({
        name: "g",
        type: "group",
        createdBy: new Types.ObjectId(sender),
        isPublic: opts.isPublic ?? false,
      });
      if (opts.member ?? true) {
        await ChatMembersModel.create({
          channelId: chat._id,
          userId: new Types.ObjectId(ownerId),
          role: "member",
        });
      }
      const message = await MessageModel.create({
        channelId: chat._id,
        senderId: new Types.ObjectId(sender),
        content: "",
        type: "gif",
        attachments: [url],
        attachmentMeta: {
          [url]: {
            mediaId: asset._id.toString(),
            width: 64,
            height: 48,
            blurhash: null,
          },
        },
      });
      return { message, asset };
    }

    it("saves the message's existing media and retains it once", async () => {
      const { message, asset } = await gifMessage();
      const item = await service.saveFromMessage(
        message._id.toString(),
        ownerId,
      );
      expect(item.mediaId).toBe(asset._id.toString());
      expect((await MediaAssetModel.findById(asset._id))?.refCount).toBe(2);

      // Saving again doesn't add a second entry or another reference.
      await service.saveFromMessage(message._id.toString(), ownerId);
      expect(await service.list(ownerId)).toHaveLength(1);
      expect((await MediaAssetModel.findById(asset._id))?.refCount).toBe(2);
      expect(await MediaAssetModel.countDocuments({})).toBe(1);
    }, 60_000);

    it("falls back to the /uploads/media/<hash>/ URL when there's no mediaId", async () => {
      const { message, asset } = await gifMessage();
      await MessageModel.updateOne(
        { _id: message._id },
        { $set: { attachmentMeta: null } },
      );
      const item = await service.saveFromMessage(
        message._id.toString(),
        ownerId,
      );
      expect(item.mediaId).toBe(asset._id.toString());
      expect((await MediaAssetModel.findById(asset._id))?.refCount).toBe(2);
    }, 60_000);

    it("refuses a message in a private chat you're not in", async () => {
      const { message } = await gifMessage({ member: false });
      await expect(
        service.saveFromMessage(message._id.toString(), ownerId),
      ).rejects.toThrow(/access denied/i);
    }, 60_000);

    it("refuses a non-GIF message", async () => {
      const { message } = await gifMessage();
      await MessageModel.updateOne(
        { _id: message._id },
        { $set: { type: "text" } },
      );
      await expect(
        service.saveFromMessage(message._id.toString(), ownerId),
      ).rejects.toThrow(/only gif messages/i);
    }, 60_000);
  });
});
