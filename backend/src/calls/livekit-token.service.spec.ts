import { RoomServiceClient } from "livekit-server-sdk";
import { LiveKitTokenService } from "./livekit-token.service";

const mockListParticipants = jest.fn();

jest.mock("livekit-server-sdk", () => ({
  RoomServiceClient: jest.fn().mockImplementation(() => ({
    listParticipants: mockListParticipants,
  })),
  AccessToken: jest.fn(),
}));

describe("LiveKit participant lookup", () => {
  const previous = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LIVEKIT_URL = "wss://chat.example.test/livekit";
    process.env.LIVEKIT_INTERNAL_URL = "http://livekit:7880";
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret";
  });

  afterEach(() => {
    process.env = { ...previous };
  });

  it("uses the internal URL for lookups and keeps the public URL for clients", async () => {
    mockListParticipants.mockResolvedValueOnce([{ identity: "alice" }]);
    const service = new LiveKitTokenService();
    await expect(service.listParticipantIdentities("room")).resolves.toEqual([
      "alice",
    ]);
    expect(RoomServiceClient).toHaveBeenCalledWith(
      "http://livekit:7880",
      "test-key",
      "test-secret",
    );
    expect(service.livekitUrl).toBe("wss://chat.example.test/livekit");
  });

  it("distinguishes a missing room from a proxy 404", async () => {
    mockListParticipants.mockRejectedValueOnce({ status: 404 });
    await expect(
      new LiveKitTokenService().listParticipantIdentities("room"),
    ).resolves.toBeNull();
    mockListParticipants.mockRejectedValueOnce({ code: "not_found" });
    await expect(
      new LiveKitTokenService().listParticipantIdentities("room"),
    ).resolves.toEqual([]);
  });
});
