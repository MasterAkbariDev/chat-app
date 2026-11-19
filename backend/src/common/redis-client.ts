import { Logger } from "@nestjs/common";
import Redis from "ioredis";

const logger = new Logger("Redis");

/**
 * Every Redis connection in the app. Commands fail fast while Redis is unreachable (callers
 * treat that as "no cache" / "allow through"), the client keeps reconnecting in the background
 * so it recovers on its own after a Redis restart, and connection errors are logged (at most once
 * a minute per client) instead of crashing the process as an unhandled 'error' event.
 */
export function createRedisClient(
  name: string,
  url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  /** false: queue commands until Redis is back instead of failing them (pub/sub connections,
   *  whose subscribe calls nobody awaits). */
  failFast = true,
): Redis {
  const client = new Redis(url, {
    connectTimeout: 2_000,
    maxRetriesPerRequest: failFast ? 1 : null,
    retryStrategy: times => Math.min(times * 1_000, 10_000),
  });
  let lastLogged = 0;
  client.on("error", (err: Error) => {
    const now = Date.now();
    if (now - lastLogged < 60_000) return;
    lastLogged = now;
    logger.warn(`${name}: ${err.message}`);
  });
  return client;
}
