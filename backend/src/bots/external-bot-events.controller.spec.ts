import { NotFoundException } from "@nestjs/common";
import { ExternalBotEventsController } from "./external-bot-events.controller";
import { BotsRegistry } from "./bots.registry";
import { BotAccessService } from "./bot-access.service";
import { BotMessagesService } from "./bot-messages.service";

describe("external bot notices", () => {
  const beforeBots = process.env.EXTERNAL_BOTS,
    beforeGrants = process.env.BOT_ACCESS_GRANTS;
  afterEach(() => {
    if (beforeBots === undefined) delete process.env.EXTERNAL_BOTS;
    else process.env.EXTERNAL_BOTS = beforeBots;
    if (beforeGrants === undefined) delete process.env.BOT_ACCESS_GRANTS;
    else process.env.BOT_ACCESS_GRANTS = beforeGrants;
  });
  it("accepts a valid bot token only for users granted access", async () => {
    const token = "a".repeat(40);
    process.env.EXTERNAL_BOTS = JSON.stringify([
      {
        key: "example",
        name: "Example",
        description: "",
        endpoint: "http://bot/events",
        token,
        accessScope: "example.use",
      },
    ]);
    process.env.BOT_ACCESS_GRANTS = JSON.stringify({
      "example.use": ["owner"],
    });
    const append = jest.fn().mockResolvedValue(undefined);
    const controller = new ExternalBotEventsController(
      new BotsRegistry([], new BotAccessService()),
      { append } as unknown as BotMessagesService,
    );
    await expect(
      controller.send("example", `Bearer ${token}`, {
        userId: "owner",
        text: "Ready",
      }),
    ).resolves.toEqual({ ok: true });
    expect(append).toHaveBeenCalledWith("owner", "example", "Ready");
    await expect(
      controller.send("example", `Bearer ${token}`, {
        userId: "other",
        text: "No",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.send("example", "Bearer wrong", {
        userId: "owner",
        text: "No",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(append).toHaveBeenCalledTimes(1);
  });
});
