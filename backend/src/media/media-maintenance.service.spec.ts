import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { MediaAsset, MediaAssetSchema } from "./schema/media-asset.schema";
import { MediaMaintenanceService } from "./media-maintenance.service";

describe("MediaMaintenanceService (B11: lifecycle tiering + orphan sweep)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let MediaAssetModel: Model<MediaAsset>;
  let service: MediaMaintenanceService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    MediaAssetModel = connection.model(MediaAsset.name, MediaAssetSchema);
    service = new MediaMaintenanceService(MediaAssetModel);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await MediaAssetModel.deleteMany({});
    delete process.env.MEDIA_COLD_TIER_DAYS;
  });

  function makeAsset(overrides: Partial<MediaAsset> = {}) {
    return MediaAssetModel.create({
      hash: `hash_${Math.random()}`,
      kind: "image",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      variants: { original: "x/original.jpg" },
      ownerId: new Types.ObjectId(),
      refCount: 1,
      ...overrides,
    });
  }

  describe("runTiering", () => {
    it("tags an asset untouched for the configured window as cold", async () => {
      process.env.MEDIA_COLD_TIER_DAYS = "10";
      const old = await makeAsset({
        lastAccessedAt: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000),
      });
      const recent = await makeAsset({
        lastAccessedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      });

      const result = await service.runTiering();
      expect(result.scanned).toBe(2);
      expect(result.taggedCold).toBe(1);

      expect((await MediaAssetModel.findById(old._id).exec())?.tier).toBe(
        "cold",
      );
      expect((await MediaAssetModel.findById(recent._id).exec())?.tier).toBe(
        "hot",
      );
    });

    it("leaves an already-cold asset alone (no-op, not double-counted)", async () => {
      process.env.MEDIA_COLD_TIER_DAYS = "10";
      await makeAsset({
        tier: "cold",
        lastAccessedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      });
      const result = await service.runTiering();
      expect(result.taggedCold).toBe(0); // already cold, $set tier:"hot"->"cold" filter excludes it
    });

    it("uses the default window when MEDIA_COLD_TIER_DAYS is unset", async () => {
      const old = await makeAsset({
        lastAccessedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
      });
      await service.runTiering();
      expect((await MediaAssetModel.findById(old._id).exec())?.tier).toBe(
        "cold",
      );
    });
  });

  describe("runOrphanReport", () => {
    it("reports assets at refCount 0 without deleting them", async () => {
      const orphan = await makeAsset({ refCount: 0, sizeBytes: 500 });
      await makeAsset({ refCount: 2 });

      const report = await service.runOrphanReport();
      expect(report.count).toBe(1);
      expect(report.totalBytes).toBe(500);
      expect(report.sampleIds).toContain(orphan._id.toString());

      // Never deletes — archive, don't delete (Q7).
      expect(await MediaAssetModel.countDocuments({})).toBe(2);
    });

    it("treats a negative refCount (shouldn't happen, but defensively) as an orphan too", async () => {
      await makeAsset({ refCount: -1 });
      const report = await service.runOrphanReport();
      expect(report.count).toBe(1);
    });

    it("reports nothing when everything is still referenced", async () => {
      await makeAsset({ refCount: 1 });
      const report = await service.runOrphanReport();
      expect(report.count).toBe(0);
      expect(report.totalBytes).toBe(0);
    });
  });
});
