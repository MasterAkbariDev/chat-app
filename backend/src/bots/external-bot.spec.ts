import { externalBots } from "./external-bot";

describe("external bot protocol", () => {
  afterEach(() => jest.restoreAllMocks());
  it("requires a scoped registration with a strong secret", () => {
    expect(
      externalBots(
        JSON.stringify([
          {
            key: "test",
            name: "Test",
            description: "",
            endpoint: "http://bot/events",
            token: "short",
          },
        ]),
      ),
    ).toEqual([]);
    expect(externalBots("not json")).toEqual([]);
  });
  it("forwards generic screen and action events to an independent service", async () => {
    const token = "a".repeat(40);
    const [bot] = externalBots(
      JSON.stringify([
        {
          key: "test",
          name: "Test",
          description: "A bot",
          endpoint: "http://bot/events",
          token,
          accessScope: "test.use",
        },
      ]),
    );
    const screen = { screenId: "home", title: "Hello", items: [], actions: [] };
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(screen), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ screen }), { status: 200 }),
      );
    expect(await bot.getScreen("home", "owner", {})).toEqual(screen);
    expect(await bot.invokeAction("go", "home", "owner", {}, [])).toEqual({
      screen,
    });
    const request = fetchMock.mock.calls[1][1];
    expect(JSON.parse(request?.body as string)).toMatchObject({
      type: "action",
      actionId: "go",
      userId: "owner",
    });
    expect(request?.headers).toMatchObject({
      authorization: `Bearer ${token}`,
    });
  });
  it("rejects oversized upstream responses without consuming later chunks", async () => {
    const [bot] = externalBots(
      JSON.stringify([
        {
          key: "test",
          name: "Test",
          description: "",
          endpoint: "http://bot/events",
          token: "a".repeat(40),
          accessScope: "test.use",
        },
      ]),
    );
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(131_073));
      },
      cancel() {
        cancelled = true;
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValueOnce(new Response(stream));
    await expect(bot.getScreen("home", "owner", {})).rejects.toThrow(
      "The bot service is unavailable.",
    );
    expect(cancelled).toBe(true);
  });
});
