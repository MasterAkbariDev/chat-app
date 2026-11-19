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
import { Pack, PackSchema } from "src/packs/schema/pack.schema";
import { PackItem, PackItemSchema } from "src/packs/schema/pack-item.schema";
import {
  PackSubscription,
  PackSubscriptionSchema,
} from "src/packs/schema/pack-subscription.schema";
import { PacksService } from "src/packs/packs.service";
import { PackManagerBot } from "./pack-manager.bot";
import { PackType } from "src/enum/base.enum";

const ONE_PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

function fakeFile(byte: number): Express.Multer.File {
  return {
    buffer: Buffer.concat([ONE_PIXEL_GIF, Buffer.from([byte])]),
  } as Express.Multer.File;
}

/**
 * End-to-end through the actual bot framework contract (`../bot.interface.ts`) — every step
 * here is exactly what `BotsController` would do: `getScreen`/`invokeAction` in, a
 * `BotMenuScreen` out. Proves the "view/create/edit/remove packs entirely via GUI menus, no
 * /commands" requirement is real, not just a shape on paper.
 */
describe("PackManagerBot (B13: GUI-menu pack management)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let bot: PackManagerBot;
  let tempRoot: string;

  const userId = "507f1f77bcf86cd799439033";

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pack-manager-bot-test-"));
    process.env.MEDIA_STORAGE_ROOT = tempRoot;

    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    const PackModel: Model<Pack> = connection.model(Pack.name, PackSchema);
    const PackItemModel: Model<PackItem> = connection.model(
      PackItem.name,
      PackItemSchema,
    );
    const PackSubscriptionModel: Model<PackSubscription> = connection.model(
      PackSubscription.name,
      PackSubscriptionSchema,
    );
    const MediaAssetModel: Model<MediaAsset> = connection.model(
      MediaAsset.name,
      MediaAssetSchema,
    );
    await Promise.all([
      PackModel.createIndexes(),
      PackItemModel.createIndexes(),
      PackSubscriptionModel.createIndexes(),
      MediaAssetModel.createIndexes(),
    ]);

    const mediaService = new MediaService(
      MediaAssetModel,
      new DiskMediaStorageService(),
    );
    const packsService = new PacksService(
      PackModel,
      PackItemModel,
      PackSubscriptionModel,
      mediaService,
    );
    bot = new PackManagerBot(packsService);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.MEDIA_STORAGE_ROOT;
  });

  it("walks the full create → add items → edit → delete flow through screens only", async () => {
    const home = await bot.getScreen("home", userId, {});
    expect(home.screenId).toBe("home");
    const createAction = home.actions.find(a => a.id === "create-pack");
    expect(createAction?.type).toBe("form");

    const afterCreate = await bot.invokeAction(
      "create-pack",
      "home",
      userId,
      { type: PackType.EMOJI, name: "Bot Test Pack", isPublic: "true" },
      [],
    );
    expect(afterCreate.screen.screenId).toBe("pack-detail");
    expect(afterCreate.screen.title).toBe("Bot Test Pack");
    expect(afterCreate.screen.toast).toMatch(/pack created/i);

    const packId = afterCreate.screen.actions.find(a => a.id === "add-items")
      ?.params?.packId as string;
    expect(packId).toBeTruthy();

    const afterAddItems = await bot.invokeAction(
      "add-items",
      "pack-detail",
      userId,
      { packId, keywords: ["😂", "lol"] },
      [fakeFile(1), fakeFile(2)],
    );
    expect(afterAddItems.screen.items).toHaveLength(2);
    expect(afterAddItems.screen.items[0].title).toBe("😂 lol");
    // Owner sees a destructive "Remove" action per item row.
    expect(afterAddItems.screen.items[0].action.id).toBe("remove-item");

    const afterEdit = await bot.invokeAction(
      "edit-pack",
      "pack-detail",
      userId,
      { packId, name: "Renamed Pack" },
      [],
    );
    expect(afterEdit.screen.title).toBe("Renamed Pack");
    expect(afterEdit.screen.toast).toMatch(/pack updated/i);

    const itemId = afterEdit.screen.items[0].id;
    const afterRemoveItem = await bot.invokeAction(
      "remove-item",
      "pack-detail",
      userId,
      { packId, itemId },
      [],
    );
    expect(afterRemoveItem.screen.items).toHaveLength(1);

    const myEmojiPacks = await bot.getScreen("my-packs", userId, {
      type: PackType.EMOJI,
    });
    expect(myEmojiPacks.items.some(i => i.id === packId)).toBe(true);

    const afterDelete = await bot.invokeAction(
      "delete-pack",
      "pack-detail",
      userId,
      { packId },
      [],
    );
    expect(afterDelete.screen.screenId).toBe("my-packs");
    expect(afterDelete.screen.toast).toMatch(/pack deleted/i);
    expect(afterDelete.screen.items.some(i => i.id === packId)).toBe(false);
  });

  it("a non-owner gets Add/Remove-from-my-packs instead of edit controls", async () => {
    const otherUserId = "507f1f77bcf86cd799439044";
    const created = await bot.invokeAction(
      "create-pack",
      "home",
      userId,
      { type: PackType.STICKER, name: "Shared Pack" },
      [],
    );
    const packId = created.screen.actions.find(a => a.id === "add-items")
      ?.params?.packId as string;

    const viewedByOther = await bot.getScreen("pack-detail", otherUserId, {
      packId,
    });
    const actionIds = viewedByOther.actions.map(a => a.id);
    expect(actionIds).toEqual(["subscribe"]);

    const afterSubscribe = await bot.invokeAction(
      "subscribe",
      "pack-detail",
      otherUserId,
      { packId },
      [],
    );
    expect(afterSubscribe.screen.actions.map(a => a.id)).toEqual([
      "unsubscribe",
    ]);
    expect(afterSubscribe.screen.toast).toMatch(/added to your packs/i);
  });

  it("add-by-link resolves a private pack by its slug without auto-adding it", async () => {
    const owner2 = "507f1f77bcf86cd799439055";
    const created = await bot.invokeAction(
      "create-pack",
      "home",
      owner2,
      { type: PackType.STICKER, name: "Invite Only", isPublic: "false" },
      [],
    );
    const slug = created.screen.subtitle?.split("/packs/")[1];
    expect(slug).toBeTruthy();

    const finder = "507f1f77bcf86cd799439066";
    const result = await bot.invokeAction(
      "add-by-link",
      "home",
      finder,
      { slugOrLink: `https://example.com/packs/${slug}` },
      [],
    );
    expect(result.screen.screenId).toBe("pack-detail");
    expect(result.screen.toast).toMatch(/tap add/i);
    expect(result.screen.actions.map(a => a.id)).toEqual(["subscribe"]);
  });
});
