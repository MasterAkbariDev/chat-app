import { PresenceService } from "./presence.service";
import { Types } from "mongoose";

// Needs a real Redis (REDIS_URL) — available in CI (see .github/workflows/ci.yml), optional for
// local runs. Skips quietly instead of hanging/failing when none is reachable.
describe("PresenceService (B3: Redis presence, not Mongo)", () => {
  let service: PresenceService;
  let redisAvailable = false;
  const userId = new Types.ObjectId().toString();

  beforeAll(async () => {
    service = new PresenceService();
    try {
      await service.isOnline(userId);
      redisAvailable = true;
    } catch {
      redisAvailable = false;
    }
  });

  afterAll(() => {
    service.onModuleDestroy();
  });

  it("is offline until marked online, then online, then offline again", async () => {
    if (!redisAvailable) return;
    expect(await service.isOnline(userId)).toBe(false);
    await service.markOnline(userId);
    expect(await service.isOnline(userId)).toBe(true);
    await service.markOffline(userId);
    expect(await service.isOnline(userId)).toBe(false);
  });

  it("touch does not error on an untouched user", async () => {
    if (!redisAvailable) return;
    await expect(service.touch(userId)).resolves.toBeUndefined();
  });
});
