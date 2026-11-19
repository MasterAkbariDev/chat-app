import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { ChatFolder, ChatFolderSchema } from "./schema/chat-folder.schema";
import { ChatType } from "src/enum/base.enum";
import type { FoldersService as FoldersServiceType } from "./folders.service";

describe("FoldersService (B6: chat folders)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ChatFolderModel: Model<ChatFolder>;
  let service: FoldersServiceType;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ChatFolderModel = connection.model(ChatFolder.name, ChatFolderSchema);

    const { FoldersService } = await import("./folders.service");
    service = new FoldersService(ChatFolderModel);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await ChatFolderModel.deleteMany({});
  });

  it("creates folders with increasing order per owner", async () => {
    const owner = "owner1";
    const f1 = await service.create(owner, { name: "Work" });
    const f2 = await service.create(owner, { name: "Family" });
    expect(f1.order).toBe(0);
    expect(f2.order).toBe(1);
  });

  it("fills in default filters when none given", async () => {
    const folder = await service.create("owner1", { name: "Unread" });
    const filters = JSON.parse(JSON.stringify(folder.filters)) as Record<
      string,
      unknown
    >;
    expect(filters).toEqual({
      includeTypes: [],
      includeTags: [],
      includeChannelIds: [],
      excludeChannelIds: [],
      onlyUnread: false,
    });
  });

  it("lists only the owner's folders, sorted by order", async () => {
    await service.create("owner1", { name: "A" });
    await service.create("owner2", { name: "B" });
    await service.create("owner1", { name: "C" });

    const list = await service.list("owner1");
    expect(list.map(f => f.name)).toEqual(["A", "C"]);
  });

  it("updates only fields provided, merging filters", async () => {
    const folder = await service.create("owner1", {
      name: "Groups",
      filters: { includeTypes: [ChatType.GROUP] },
    });
    const updated = await service.update("owner1", String(folder._id), {
      filters: { onlyUnread: true },
    });
    expect(updated.name).toBe("Groups");
    expect(updated.filters.includeTypes).toEqual([ChatType.GROUP]);
    expect(updated.filters.onlyUnread).toBe(true);
  });

  it("rejects updating/deleting/reading another owner's folder", async () => {
    const folder = await service.create("owner1", { name: "Private" });
    await expect(
      service.update("owner2", String(folder._id), { name: "Hijacked" }),
    ).rejects.toThrow(/not found/i);
    await expect(
      service.getOwnedFolder("owner2", String(folder._id)),
    ).rejects.toThrow(/not found/i);

    await service.remove("owner2", String(folder._id));
    const stillThere = await service.getOwnedFolder(
      "owner1",
      String(folder._id),
    );
    expect(stillThere).toBeTruthy();
  });
});
