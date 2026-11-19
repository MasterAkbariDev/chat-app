import { NotFoundException } from "@nestjs/common";
import { BotHandler } from "./bot.interface";
import { BotAccessService } from "./bot-access.service";
import { BotsRegistry } from "./bots.registry";

const bot = (key: string, accessScope?: string): BotHandler => ({
  key,
  name: key,
  description: key,
  accessScope,
  getScreen: jest.fn(),
  invokeAction: jest.fn(),
});

describe("bot permissions", () => {
  const saved = process.env.BOT_ACCESS_GRANTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.BOT_ACCESS_GRANTS;
    else process.env.BOT_ACCESS_GRANTS = saved;
  });

  it("hides scoped bots and rejects direct access for other users", () => {
    process.env.BOT_ACCESS_GRANTS = JSON.stringify({
      "controls.manage": ["owner-id"],
    });
    const registry = new BotsRegistry(
      [bot("public"), bot("controls", "controls.manage")],
      new BotAccessService(),
    );
    expect(registry.list("owner-id").map(b => b.key)).toEqual([
      "public",
      "controls",
    ]);
    expect(registry.list("other-id").map(b => b.key)).toEqual(["public"]);
    expect(() => registry.get("controls", "other-id")).toThrow(
      NotFoundException,
    );
    expect(registry.get("controls", "owner-id").key).toBe("controls");
  });

  it("fails closed on malformed policy while preserving unscoped bots", () => {
    process.env.BOT_ACCESS_GRANTS = '{"controls.manage":["owner-id"],"bad":42}';
    const registry = new BotsRegistry(
      [bot("public"), bot("controls", "controls.manage")],
      new BotAccessService(),
    );
    expect(registry.list("owner-id").map(b => b.key)).toEqual(["public"]);
    expect(() => registry.get("controls", "owner-id")).toThrow(
      NotFoundException,
    );
  });
});
