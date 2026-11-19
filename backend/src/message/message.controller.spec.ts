import type { MessageService } from "./message.service";
import type { ChatGateway } from "src/gateway/chat.gateway";

/**
 * Regression test for Architecture Rule #16 (B12): `POST /messages` used to create the message
 * and return silently — only the WS `send_message` path broadcast it. A client connected only
 * over Socket.IO never saw a REST-created message until its next fetch. See
 * `docs/THINGS_TO_REMOVE.md` / README's B12 section for the live-verified fix.
 *
 * `MessageController` transitively imports `ChatGateway`, whose `@WebSocketGateway()` decorator
 * reads `process.env.CORS_ORIGIN` at module-evaluation time (fails closed if unset) — so, same
 * as `moderation.service.spec.ts`, the controller is imported dynamically after CORS_ORIGIN is
 * set, not statically at the top of the file.
 */
describe("MessageController#create", () => {
  it("broadcasts the newly created message to the channel over the gateway", async () => {
    process.env.CORS_ORIGIN =
      process.env.CORS_ORIGIN ?? "http://localhost:3000";
    const { MessageController } = await import("./message.controller");

    const createdMessage = {
      _id: "msg1",
      channelId: "chan1",
      content: "hello",
    };
    const createMock = jest.fn().mockResolvedValue(createdMessage);
    const broadcastNewMessageMock = jest.fn();
    const messageService = {
      create: createMock,
    } as unknown as MessageService;
    const chatGateway = {
      broadcastNewMessage: broadcastNewMessageMock,
    } as unknown as ChatGateway;

    const controller = new MessageController(
      messageService,
      chatGateway,
      {} as never,
    );
    const result = await controller.create(
      { channelId: "chan1", content: "hello" },
      { user: { userId: "user1" } } as never,
    );

    expect(createMock).toHaveBeenCalledWith(
      { channelId: "chan1", content: "hello" },
      "user1",
    );
    expect(broadcastNewMessageMock).toHaveBeenCalledWith(
      "chan1",
      createdMessage,
    );
    expect(result).toBe(createdMessage);
  });
});
