import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { createRedisClient } from "src/common/redis-client";

const CACHE_TTL_SEC = 300; // 5 min — bounded staleness after a revoke, not indefinite trust
const keyFor = (userId: string) => `auth:userstate:${userId}`;
/** A revoked device's session family is marked this long: longer than any access token lives (15 min). */
const FAMILY_REVOKED_TTL_SEC = 16 * 60;
const familyKey = (familyId: string) => `auth:family-revoked:${familyId}`;

export interface CachedUserState {
  tokenVersion: number;
  isDeleted: boolean;
  /** ISO string (Redis/JSON can't hold a Date) — null means not suspended (B10). */
  suspendedUntil: string | null;
}

/**
 * Redis cache in front of the two fields `JwtStrategy` needs on every request
 * (docs/plans/BACKEND_PLAN.md B4: "0 Mongo reads on the hot path"). A cache miss falls back to
 * Mongo and repopulates; `invalidate` is called wherever tokenVersion changes or the account is
 * deleted, so a revoke is visible within one request, not just after the TTL.
 */
@Injectable()
export class TokenCacheService implements OnModuleDestroy {
  private readonly redis = createRedisClient("auth cache");

  async get(userId: string): Promise<CachedUserState | null> {
    try {
      const raw = await this.redis.get(keyFor(userId));
      return raw ? (JSON.parse(raw) as CachedUserState) : null;
    } catch {
      return null; // Redis down — caller falls back to Mongo, never blocks auth on this cache.
    }
  }

  async markFamilyRevoked(familyId: string): Promise<void> {
    try {
      await this.redis.set(
        familyKey(familyId),
        "1",
        "EX",
        FAMILY_REVOKED_TTL_SEC,
      );
    } catch {
      // Redis down: the access token still expires within 15 min; the revoke takes effect then.
    }
  }

  async isFamilyRevoked(familyId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(familyKey(familyId))) === 1;
    } catch {
      return false; // Redis down: fail open, same as the user-state cache.
    }
  }

  async set(userId: string, state: CachedUserState): Promise<void> {
    try {
      await this.redis.set(
        keyFor(userId),
        JSON.stringify(state),
        "EX",
        CACHE_TTL_SEC,
      );
    } catch {
      /* best-effort */
    }
  }

  async invalidate(userId: string): Promise<void> {
    try {
      await this.redis.del(keyFor(userId));
    } catch {
      /* best-effort */
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
