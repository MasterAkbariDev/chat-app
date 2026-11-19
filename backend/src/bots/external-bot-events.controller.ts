import {
  Body,
  Controller,
  Headers,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { BotsRegistry } from "./bots.registry";
import { BotMessagesService } from "./bot-messages.service";
import { externalBots } from "./external-bot";
import { Public } from "src/common/decorators/public.decorator";

/** Bots may post notices only to users who already have access to that bot. */
@Controller({ path: "bot-events", version: "1" })
@Public() // This endpoint authenticates a bot token instead of a user JWT.
export class ExternalBotEventsController {
  constructor(
    private readonly registry: BotsRegistry,
    private readonly messages: BotMessagesService,
  ) {}
  @Post(":key/messages")
  async send(
    @Param("key") key: string,
    @Headers("authorization") auth: string | undefined,
    @Body() body: unknown,
  ) {
    const raw = process.env.EXTERNAL_BOTS || "[]";
    if (!externalBots(raw).some(bot => bot.key === key))
      throw new NotFoundException();
    let list: unknown;
    try {
      list = JSON.parse(raw) as unknown;
    } catch {
      throw new NotFoundException();
    }
    const config = Array.isArray(list)
      ? (list as unknown[])
          .filter(
            (x): x is Record<string, unknown> => !!x && typeof x === "object",
          )
          .findLast(x => x.key === key)
      : undefined;
    const token = typeof config?.token === "string" ? config.token : "";
    const expected = Buffer.from(`Bearer ${token}`),
      provided = Buffer.from(auth || "");
    if (
      !token ||
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    )
      throw new NotFoundException();
    if (
      !body ||
      typeof body !== "object" ||
      !("userId" in body) ||
      typeof body.userId !== "string" ||
      !("text" in body) ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 2000
    )
      throw new NotFoundException();
    this.registry.get(key, body.userId);
    await this.messages.append(body.userId, key, body.text);
    return { ok: true };
  }
}
