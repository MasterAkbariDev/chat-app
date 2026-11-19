import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { createRedisClient } from "src/common/redis-client";

const PRESENCE_TTL_SEC = 30;
const keyFor = (userId: string) => `presence:${userId}`;

/**
 * Online/offline in Redis, not Mongo (B3 — docs/plans/BACKEND_PLAN.md: "Drop user.isOnline").
 * A `presence:<uid>` key with a short TTL is the source of truth; the gateway refreshes it on
 * connect and periodically while a socket stays open, so a crashed process's users go offline
 * automatically once the key expires (no explicit cleanup needed).
 */
@Injectable()
export class PresenceService implements OnModuleDestroy {
  // Fail fast rather than queueing commands against a Redis that never responds — a gateway
  // connect/disconnect must not hang the socket if Redis is briefly unreachable.
  private readonly redis = createRedisClient("presence");

  async markOnline(userId: string): Promise<void> {
    await this.redis.set(keyFor(userId), "1", "EX", PRESENCE_TTL_SEC);
  }

  async touch(userId: string): Promise<void> {
    await this.redis.expire(keyFor(userId), PRESENCE_TTL_SEC);
  }

  async markOffline(userId: string): Promise<void> {
    await this.redis.del(keyFor(userId));
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.redis.exists(keyFor(userId))) === 1;
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
