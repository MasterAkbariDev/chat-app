import { Injectable, Logger } from "@nestjs/common";
import { BotHandler } from "./bot.interface";

/** Grants are keyed by scope and stable chat user ID, not mutable or unverified email. */
@Injectable()
export class BotAccessService {
  private readonly logger = new Logger(BotAccessService.name);
  private readonly grants: Record<string, string[]> = {};

  constructor() {
    const raw = process.env.BOT_ACCESS_GRANTS;
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      for (const [scope, users] of Object.entries(parsed)) {
        if (!Array.isArray(users) || !users.every(id => typeof id === "string"))
          throw new Error();
        this.grants[scope] = users;
      }
    } catch {
      // Fail closed: do not keep a partially parsed policy.
      for (const scope of Object.keys(this.grants)) delete this.grants[scope];
      this.logger.error(
        "Invalid BOT_ACCESS_GRANTS; restricted bots are disabled",
      );
    }
  }

  allows(handler: BotHandler, userId: string): boolean {
    return (
      !handler.accessScope ||
      !!this.grants[handler.accessScope]?.includes(userId)
    );
  }
}
