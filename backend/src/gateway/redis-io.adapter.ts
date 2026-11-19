import { IoAdapter } from "@nestjs/platform-socket.io";
import { INestApplicationContext } from "@nestjs/common";
import { ServerOptions } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createRedisClient } from "src/common/redis-client";

/**
 * Cross-node Socket.IO delivery (B3 — docs/plans/BACKEND_PLAN.md): without this, a `channel:<id>`
 * room only reaches sockets connected to the SAME API process, so running >1 node silently drops
 * messages to members connected elsewhere. Two dedicated ioredis clients (pub/sub only, never
 * used for app data) mirror emits across every node subscribed to the same Redis.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(
    app: INestApplicationContext,
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  connectToRedis(): void {
    const pubClient = createRedisClient(
      "socket.io publish",
      this.redisUrl,
      false,
    );
    const subClient = createRedisClient(
      "socket.io subscribe",
      this.redisUrl,
      false,
    );
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options) as {
      adapter: (a: ReturnType<typeof createAdapter>) => void;
    };
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
