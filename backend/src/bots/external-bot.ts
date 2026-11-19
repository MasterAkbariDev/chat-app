import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { BotActionResult, BotHandler, BotMenuScreen } from "./bot.interface";

export interface ExternalBotConfig {
  key: string;
  name: string;
  description: string;
  endpoint: string;
  token: string;
  accessScope: string;
}

// Bound the body while reading it, including error responses, rather than after
// buffering an arbitrary upstream response in memory.
async function readLimitedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131_072) {
        await reader.cancel();
        throw new Error("Bot response too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** An independently deployed bot receives generic screen and action events. */
export class ExternalBot implements BotHandler {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly accessScope: string;
  constructor(private readonly config: ExternalBotConfig) {
    this.key = config.key;
    this.name = config.name;
    this.description = config.description;
    this.accessScope = config.accessScope;
  }
  private async request(event: object): Promise<unknown> {
    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(120_000),
        redirect: "error",
      });
      if (response.status === 400) {
        const value: unknown = JSON.parse(await readLimitedResponse(response));
        if (
          value &&
          typeof value === "object" &&
          "error" in value &&
          typeof value.error === "string"
        )
          throw new BadRequestException(value.error.slice(0, 240));
        throw new BadRequestException("The bot could not perform that action.");
      }
      if (!response.ok) throw new Error("Bot rejected event");
      const text = await readLimitedResponse(response);
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException("The bot service is unavailable.");
    }
  }
  private screen(value: unknown): BotMenuScreen {
    if (
      !value ||
      typeof value !== "object" ||
      !("screenId" in value) ||
      typeof value.screenId !== "string" ||
      !("title" in value) ||
      typeof value.title !== "string" ||
      !("items" in value) ||
      !Array.isArray(value.items) ||
      !("actions" in value) ||
      !Array.isArray(value.actions)
    )
      throw new ServiceUnavailableException(
        "The bot returned an invalid screen.",
      );
    return value as BotMenuScreen;
  }
  async getScreen(
    screenId: string,
    userId: string,
    params: Record<string, unknown>,
  ): Promise<BotMenuScreen> {
    return this.screen(
      await this.request({ type: "screen", screenId, userId, params }),
    );
  }
  async invokeAction(
    actionId: string,
    screenId: string,
    userId: string,
    params: Record<string, unknown>,
    files: Express.Multer.File[],
  ): Promise<BotActionResult> {
    const value = await this.request({
      type: "action",
      actionId,
      screenId,
      userId,
      params,
      files: files.map(f => ({
        name: f.originalname,
        mimeType: f.mimetype,
        data: f.buffer.toString("base64"),
      })),
    });
    if (!value || typeof value !== "object" || !("screen" in value))
      throw new ServiceUnavailableException(
        "The bot returned an invalid action response.",
      );
    return { screen: this.screen(value.screen) };
  }
}

/** External registrations are deployment-owned and always require an explicit grant. */
export function externalBots(raw: string | undefined): ExternalBot[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const x = item as Record<string, unknown>;
      if (
        typeof x.key !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(x.key) ||
        typeof x.name !== "string" ||
        typeof x.description !== "string" ||
        typeof x.endpoint !== "string" ||
        typeof x.token !== "string" ||
        x.token.length < 32 ||
        typeof x.accessScope !== "string" ||
        !x.accessScope
      )
        return [];
      const url = new URL(x.endpoint);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        return [];
      return [new ExternalBot(x as unknown as ExternalBotConfig)];
    });
  } catch {
    return [];
  }
}
