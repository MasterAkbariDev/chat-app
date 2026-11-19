import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { BOT_HANDLERS, BotHandler, BotSummary } from "./bot.interface";
import { BotAccessService } from "./bot-access.service";
import { externalBots } from "./external-bot";

@Injectable()
export class BotsRegistry {
  private readonly byKey = new Map<string, BotHandler>();

  constructor(
    @Inject(BOT_HANDLERS) handlers: BotHandler[],
    private readonly access: BotAccessService,
  ) {
    for (const handler of handlers) {
      this.byKey.set(handler.key, handler);
    }
    for (const handler of externalBots(process.env.EXTERNAL_BOTS)) {
      this.byKey.set(handler.key, handler);
    }
  }

  list(userId: string): BotSummary[] {
    return [...this.byKey.values()]
      .filter(handler => this.access.allows(handler, userId))
      .map(({ key, name, description, avatarUrl }) => ({
        key,
        name,
        description,
        avatarUrl,
      }));
  }

  get(key: string, userId: string): BotHandler {
    const handler = this.byKey.get(key);
    if (!handler || !this.access.allows(handler, userId))
      throw new NotFoundException("Bot not found");
    return handler;
  }
}
