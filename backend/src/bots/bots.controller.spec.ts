import { NotFoundException } from "@nestjs/common";
import { JWTPayload } from "src/interface/base.interface";
import { BotAccessService } from "./bot-access.service";
import { BotHandler } from "./bot.interface";
import { BotsController } from "./bots.controller";
import { BotsRegistry } from "./bots.registry";

describe("bot route authorization", () => {
  const previous = process.env.BOT_ACCESS_GRANTS;
  afterEach(() => {
    if (previous === undefined) delete process.env.BOT_ACCESS_GRANTS;
    else process.env.BOT_ACCESS_GRANTS = previous;
  });
  it("blocks every protected endpoint before invoking its handler", () => {
    process.env.BOT_ACCESS_GRANTS = JSON.stringify({
      "controls.manage": ["owner"],
    });
    const getScreen = jest.fn();
    const invokeAction = jest.fn();
    const handler: BotHandler = {
      key: "controls",
      name: "Controls",
      description: "",
      accessScope: "controls.manage",
      getScreen,
      invokeAction,
    };
    const controller = new BotsController(
      new BotsRegistry([handler], new BotAccessService()),
    );
    const req = { user: { userId: "other" } as JWTPayload };
    expect(controller.list(req)).toEqual([]);
    expect(() => controller.getMenu("controls", req)).toThrow(
      NotFoundException,
    );
    expect(() =>
      controller.invokeAction(
        "controls",
        { actionId: "stop", screenId: "home" },
        req,
      ),
    ).toThrow(NotFoundException);
    expect(() =>
      controller.invokeActionWithUpload(
        "controls",
        { actionId: "stop", screenId: "home" },
        [],
        req,
      ),
    ).toThrow(NotFoundException);
    expect(getScreen).not.toHaveBeenCalled();
    expect(invokeAction).not.toHaveBeenCalled();
  });
});
