import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MediaAsset,
  MediaAssetSchema,
} from "src/media/schema/media-asset.schema";
import { MediaService } from "src/media/media.service";
import { DiskMediaStorageService } from "src/media/storage/disk-media-storage.service";
import { GiphyMedia, GiphyMediaSchema } from "./schema/giphy-media.schema";
import { GiphyService } from "./giphy.service";
import type { GiphyItem } from "./giphy-client.service";

// Smallest possible valid GIF (1x1, transparent) — real magic bytes, so
// MediaService's sniffImageType/ingestImage pipeline runs for real.
const ONE_PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

describe("GiphyService (B9: cache Giphy assets on first use)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MediaAssetModel: Model<MediaAsset>;
  let GiphyMediaModel: Model<GiphyMedia>;
  let mediaService: MediaService;
  let service: GiphyService;
  let tempRoot: string;
  let fakeClient: {
    search: jest.Mock;
    trending: jest.Mock;
    getById: jest.Mock;
    fetchBytes: jest.Mock;
  };

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "giphy-service-test-"));
    process.env.MEDIA_STORAGE_ROOT = tempRoot;

    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    MediaAssetModel = connection.model(MediaAsset.name, MediaAssetSchema);
    GiphyMediaModel = connection.model(GiphyMedia.name, GiphyMediaSchema);
    await Promise.all([
      MediaAssetModel.createIndexes(),
      GiphyMediaModel.createIndexes(),
    ]);

    mediaService = new MediaService(
      MediaAssetModel,
      new DiskMediaStorageService(),
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.MEDIA_STORAGE_ROOT;
  });

  beforeEach(() => {
    fakeClient = {
      search: jest.fn(),
      trending: jest.fn(),
      getById: jest.fn(),
      fetchBytes: jest.fn().mockResolvedValue(ONE_PIXEL_GIF),
    };
    service = new GiphyService(
      GiphyMediaModel,
      fakeClient as never,
      mediaService,
    );
  });

  afterEach(async () => {
    await Promise.all([
      MediaAssetModel.deleteMany({}),
      GiphyMediaModel.deleteMany({}),
    ]);
  });

  const ownerId = "507f1f77bcf86cd799439011";

  function makeItem(overrides: Partial<GiphyItem> = {}): GiphyItem {
    return {
      id: "abc123",
      title: "a funny gif",
      originalUrl: "https://media.giphy.com/media/abc123/giphy.gif",
      previewUrl: "https://media.giphy.com/media/abc123/200.gif",
      ...overrides,
    };
  }

  describe("useGiphyAsset", () => {
    it("downloads and mirrors into MediaService on first use", async () => {
      fakeClient.getById.mockResolvedValue(makeItem());

      const result = await service.useGiphyAsset("gif", "abc123", ownerId);

      expect(fakeClient.getById).toHaveBeenCalledWith("gif", "abc123");
      expect(fakeClient.fetchBytes).toHaveBeenCalledWith(
        "https://media.giphy.com/media/abc123/giphy.gif",
      );
      expect(result.title).toBe("a funny gif");
      expect(result.relativePath).toMatch(/original\.gif$/);

      const stored = await GiphyMediaModel.findOne({
        giphyId: "abc123",
        kind: "gif",
      }).exec();
      expect(stored?.usageCount).toBe(1);

      const assetCount = await MediaAssetModel.countDocuments({});
      expect(assetCount).toBe(1);
    });

    it("does not call Giphy again on a second use of the same id", async () => {
      fakeClient.getById.mockResolvedValue(makeItem());

      await service.useGiphyAsset("gif", "abc123", ownerId);
      const second = await service.useGiphyAsset("gif", "abc123", ownerId);

      expect(fakeClient.getById).toHaveBeenCalledTimes(1);
      expect(fakeClient.fetchBytes).toHaveBeenCalledTimes(1);
      expect(second.title).toBe("a funny gif");

      const stored = await GiphyMediaModel.findOne({
        giphyId: "abc123",
        kind: "gif",
      }).exec();
      expect(stored?.usageCount).toBe(2);

      // Still just one media_assets row — no duplicate storage either.
      const assetCount = await MediaAssetModel.countDocuments({});
      expect(assetCount).toBe(1);
    });

    it("keeps gifs and stickers with the same Giphy id as separate cache entries", async () => {
      fakeClient.getById.mockResolvedValue(makeItem());

      await service.useGiphyAsset("gif", "abc123", ownerId);
      await service.useGiphyAsset("sticker", "abc123", ownerId);

      const count = await GiphyMediaModel.countDocuments({ giphyId: "abc123" });
      expect(count).toBe(2);
    });
  });

  describe("search / trending (cache-status flag)", () => {
    it("flags a not-yet-used result as uncached", async () => {
      fakeClient.search.mockResolvedValue([makeItem({ id: "neverused" })]);

      const results = await service.search("gif", "cats", 10, 0);
      expect(results[0].cachedRelativePath).toBeNull();
    });

    it("flags an already-used result as cached, with its local path", async () => {
      fakeClient.getById.mockResolvedValue(makeItem({ id: "seenbefore" }));
      await service.useGiphyAsset("gif", "seenbefore", ownerId);

      fakeClient.search.mockResolvedValue([makeItem({ id: "seenbefore" })]);
      const results = await service.search("gif", "cats", 10, 0);

      expect(results[0].cachedRelativePath).toMatch(/original\.gif$/);
    });
  });
});
