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
import { Pack, PackSchema } from "./schema/pack.schema";
import { PackItem, PackItemSchema } from "./schema/pack-item.schema";
import {
  PackSubscription,
  PackSubscriptionSchema,
} from "./schema/pack-subscription.schema";
import { PacksService } from "./packs.service";
import { PackType } from "src/enum/base.enum";

// Smallest possible valid GIF (1x1, transparent) — real magic bytes, so MediaService's
// sniffImageType/ingestImage pipeline runs for real, same fixture used across the media specs.
const ONE_PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

function fakeFile(byte: number): Express.Multer.File {
  return {
    buffer: Buffer.concat([ONE_PIXEL_GIF, Buffer.from([byte])]),
  } as Express.Multer.File;
}

describe("PacksService (B13: unified sticker/animated-emoji packs)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let PackModel: Model<Pack>;
  let PackItemModel: Model<PackItem>;
  let PackSubscriptionModel: Model<PackSubscription>;
  let MediaAssetModel: Model<MediaAsset>;
  let mediaService: MediaService;
  let service: PacksService;
  let tempRoot: string;

  const ownerId = "507f1f77bcf86cd799439011";
  const otherId = "507f1f77bcf86cd799439022";

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "packs-service-test-"));
    process.env.MEDIA_STORAGE_ROOT = tempRoot;

    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    PackModel = connection.model(Pack.name, PackSchema);
    PackItemModel = connection.model(PackItem.name, PackItemSchema);
    PackSubscriptionModel = connection.model(
      PackSubscription.name,
      PackSubscriptionSchema,
    );
    MediaAssetModel = connection.model(MediaAsset.name, MediaAssetSchema);
    await Promise.all([
      PackModel.createIndexes(),
      PackItemModel.createIndexes(),
      PackSubscriptionModel.createIndexes(),
      MediaAssetModel.createIndexes(),
    ]);

    mediaService = new MediaService(
      MediaAssetModel,
      new DiskMediaStorageService(),
    );
    service = new PacksService(
      PackModel,
      PackItemModel,
      PackSubscriptionModel,
      mediaService,
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.MEDIA_STORAGE_ROOT;
  });

  it("auto-subscribes the owner on create, and gives the pack a slug", async () => {
    const pack = await service.create(
      { type: PackType.STICKER, name: "Party Cats" },
      ownerId,
    );
    expect(pack.slug).toBe("party-cats");
    expect(pack.isOwner).toBe(true);
    expect(pack.isSubscribed).toBe(true);

    const mine = await service.listMine(ownerId, PackType.STICKER);
    expect(mine.map(p => p.id)).toContain(pack.id);
  });

  it("dedupes slugs on name collision", async () => {
    const first = await service.create(
      { type: PackType.STICKER, name: "Dupe" },
      ownerId,
    );
    const second = await service.create(
      { type: PackType.STICKER, name: "Dupe" },
      ownerId,
    );
    expect(first.slug).not.toBe(second.slug);
  });

  it("listMine filters by pack type", async () => {
    const sticker = await service.create(
      { type: PackType.STICKER, name: `Stk ${Date.now()}` },
      ownerId,
    );
    const emoji = await service.create(
      { type: PackType.EMOJI, name: `Emo ${Date.now()}` },
      ownerId,
    );

    const stickers = await service.listMine(ownerId, PackType.STICKER);
    const emojis = await service.listMine(ownerId, PackType.EMOJI);
    expect(stickers.some(p => p.id === sticker.id)).toBe(true);
    expect(stickers.some(p => p.id === emoji.id)).toBe(false);
    expect(emojis.some(p => p.id === emoji.id)).toBe(true);
  });

  it("only surfaces public packs in search, never private ones", async () => {
    const suffix = Date.now();
    const pub = await service.create(
      { type: PackType.STICKER, name: `Findable ${suffix}`, isPublic: true },
      ownerId,
    );
    const priv = await service.create(
      {
        type: PackType.STICKER,
        name: `Findable ${suffix} hidden`,
        isPublic: false,
      },
      ownerId,
    );

    const results = await service.search(
      `Findable ${suffix}`,
      PackType.STICKER,
    );
    expect(results.some(p => p.id === pub.id)).toBe(true);
    expect(results.some(p => p.id === priv.id)).toBe(false);
  });

  it("a private pack is still fully viewable/addable by anyone who has its id or slug", async () => {
    const priv = await service.create(
      { type: PackType.STICKER, name: `Secret ${Date.now()}`, isPublic: false },
      ownerId,
    );

    const bySlug = await service.findBySlug(priv.slug, otherId);
    expect(bySlug.id).toBe(priv.id);
    expect(bySlug.isSubscribed).toBe(false);

    await service.subscribe(priv.id, otherId);
    const afterSubscribe = await service.findOne(priv.id, otherId);
    expect(afterSubscribe.isSubscribed).toBe(true);
  });

  it("only the owner can add, edit, or remove items — and item search is scoped to my own packs", async () => {
    const pack = await service.create(
      { type: PackType.EMOJI, name: `Laughs ${Date.now()}` },
      ownerId,
    );

    await expect(
      service.addItems(pack.id, [fakeFile(1)], ["😂"], otherId),
    ).rejects.toThrow(/only modify your own/i);

    const [item] = await service.addItems(
      pack.id,
      [fakeFile(1)],
      ["😂", "😆"],
      ownerId,
    );
    expect(item.keywords).toEqual(["😂", "😆"]);

    // Not yet subscribed — the owner's own pack search only covers *their* subscriptions,
    // and `otherId` hasn't added this pack.
    const beforeSubscribe = await service.searchMyItems(otherId, "😂");
    expect(beforeSubscribe).toHaveLength(0);

    await service.subscribe(pack.id, otherId);
    const afterSubscribe = await service.searchMyItems(otherId, "😂");
    expect(afterSubscribe.some(i => i.id === item.id)).toBe(true);

    await expect(
      service.updateItem(pack.id, item.id, { keywords: ["lol"] }, otherId),
    ).rejects.toThrow(/only modify your own/i);
    const updated = await service.updateItem(
      pack.id,
      item.id,
      { keywords: ["lol"] },
      ownerId,
    );
    expect(updated.keywords).toEqual(["lol"]);

    await expect(service.removeItem(pack.id, item.id, otherId)).rejects.toThrow(
      /only modify your own/i,
    );
    await service.removeItem(pack.id, item.id, ownerId);
    const detail = await service.findOne(pack.id, ownerId);
    expect(detail.items).toHaveLength(0);
    expect(detail.itemCount).toBe(0);
  });

  it("using an item requires having the pack first", async () => {
    const pack = await service.create(
      { type: PackType.STICKER, name: `UseGate ${Date.now()}` },
      ownerId,
    );
    const [item] = await service.addItems(pack.id, [fakeFile(2)], [], ownerId);

    await expect(service.useItem(pack.id, item.id, otherId)).rejects.toThrow(
      /add this pack before using it/i,
    );

    await service.subscribe(pack.id, otherId);
    await service.useItem(pack.id, item.id, otherId);
    const detail = await service.findOne(pack.id, ownerId);
    expect(detail.items[0].usageCount).toBe(1);
    expect(detail.totalUsageCount).toBe(1);
  });

  it("unsubscribing removes it from 'my packs' without deleting the pack (works for the owner too)", async () => {
    const pack = await service.create(
      { type: PackType.STICKER, name: `Unsub ${Date.now()}` },
      ownerId,
    );

    await service.unsubscribe(pack.id, ownerId);
    const mine = await service.listMine(ownerId, PackType.STICKER);
    expect(mine.some(p => p.id === pack.id)).toBe(false);

    // Still fully accessible — unsubscribing is not deleting.
    const still = await service.findOne(pack.id, ownerId);
    expect(still.id).toBe(pack.id);
    expect(still.isOwner).toBe(true);
    expect(still.isSubscribed).toBe(false);
  });

  it("deleting a pack releases every item's MediaAsset ref and drops every subscriber's copy", async () => {
    const pack = await service.create(
      { type: PackType.STICKER, name: `Doomed ${Date.now()}` },
      ownerId,
    );
    const [item] = await service.addItems(pack.id, [fakeFile(3)], [], ownerId);
    await service.subscribe(pack.id, otherId);

    const assetBefore = await MediaAssetModel.findOne({
      _id: (await PackItemModel.findById(item.id).lean().exec())?.mediaId,
    }).exec();
    expect(assetBefore?.refCount).toBe(1);

    await service.deletePack(pack.id, ownerId);

    expect(await PackItemModel.countDocuments({ packId: pack.id })).toBe(0);
    expect(
      await PackSubscriptionModel.countDocuments({ packId: pack.id }),
    ).toBe(0);
    const assetAfter = await MediaAssetModel.findById(assetBefore?._id).exec();
    expect(assetAfter?.refCount).toBe(0);

    await expect(service.findOne(pack.id, ownerId)).rejects.toThrow(
      /not found/i,
    );
  });

  it("reorderMine reorders one type's packs and leaves the others in place", async () => {
    const user = "507f1f77bcf86cd7994390ee";
    const mk = async (type: PackType, name: string) => {
      const p = await service.create(
        { type, name: `${name} ${Date.now()}` },
        ownerId,
      );
      await service.subscribe(p.id, user);
      return p.id;
    };
    const s1 = await mk(PackType.STICKER, "S1");
    const e1 = await mk(PackType.EMOJI, "E1");
    const s2 = await mk(PackType.STICKER, "S2");
    const s3 = await mk(PackType.STICKER, "S3");

    await service.reorderMine(user, [s3, s1, s2, "507f1f77bcf86cd799439000"]);
    expect(
      (await service.listMine(user, PackType.STICKER)).map(p => p.id),
    ).toEqual([s3, s1, s2]);
    expect((await service.listMine(user)).map(p => p.id)).toEqual([
      s3,
      e1,
      s1,
      s2,
    ]);

    // A newly added pack goes after everything, even after reordering/removals.
    await service.unsubscribe(s1, user);
    const s4 = await mk(PackType.STICKER, "S4");
    expect(
      (await service.listMine(user, PackType.STICKER)).map(p => p.id),
    ).toEqual([s3, s2, s4]);
  });
});
