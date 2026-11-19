import { CallStateService, CallState } from "./call-state.service";
import { randomUUID } from "crypto";

// Needs a real Redis (REDIS_URL) — available in CI, optional for local runs. Skips quietly
// instead of hanging/failing when none is reachable (same pattern as presence.service.spec.ts).
describe("CallStateService (B8: call state in Redis, not process memory)", () => {
  let service: CallStateService;
  let redisAvailable = false;

  beforeAll(async () => {
    service = new CallStateService();
    try {
      await service.get("probe");
      redisAvailable = true;
    } catch {
      redisAvailable = false;
    }
  });

  afterAll(() => {
    service.onModuleDestroy();
  });

  function makeState(overrides: Partial<CallState> = {}): CallState {
    const callId = randomUUID();
    return {
      callId,
      channelId: randomUUID(),
      isPrivate: true,
      initiatorId: randomUUID(),
      participantIds: [],
      startedAt: null,
      createdAt: Date.now(),
      roomName: `call-${callId}`,
      ...overrides,
    };
  }

  it("returns null for a call that was never created", async () => {
    if (!redisAvailable) return;
    expect(await service.get(randomUUID())).toBeNull();
  });

  it("round-trips a created call", async () => {
    if (!redisAvailable) return;
    const state = makeState();
    await service.create(state);
    const fetched = await service.get(state.callId);
    expect(fetched).toEqual(state);
    await service.delete(state.callId, state.channelId, state.isPrivate);
  });

  it("save() persists mutations", async () => {
    if (!redisAvailable) return;
    const state = makeState();
    await service.create(state);
    state.participantIds.push("someUserId");
    state.startedAt = Date.now();
    await service.save(state);
    const fetched = await service.get(state.callId);
    expect(fetched?.participantIds).toEqual(["someUserId"]);
    expect(fetched?.startedAt).not.toBeNull();
    await service.delete(state.callId, state.channelId, state.isPrivate);
  });

  it("claimChannel: one live call per chat (NX), released on delete only by its owner", async () => {
    if (!redisAvailable) return;
    const state = makeState({ isPrivate: true });
    expect(await service.claimChannel(state.channelId, state.callId)).toBe(
      true,
    );
    expect(await service.claimChannel(state.channelId, "other-call")).toBe(
      false,
    );
    await service.create(state);
    expect(await service.getActiveCallIdForChannel(state.channelId)).toBe(
      state.callId,
    );
    // Deleting some other call doesn't release this chat's slot.
    await service.delete("other-call", state.channelId);
    expect(await service.getActiveCallIdForChannel(state.channelId)).toBe(
      state.callId,
    );
    await service.delete(state.callId, state.channelId, state.isPrivate);
    expect(await service.getActiveCallIdForChannel(state.channelId)).toBeNull();
  });

  it("indexes ringing calls per callee, and the active set, until delete", async () => {
    if (!redisAvailable) return;
    const callee = randomUUID();
    const state = makeState({ ringingUserIds: [callee] });
    await service.create(state);
    expect(await service.ringingCallIdsFor(callee)).toEqual([state.callId]);
    expect(await service.activeCallIds()).toContain(state.callId);
    expect(
      (await service.getActiveCallsForChannels([state.channelId])).size,
    ).toBe(0); // not claimed
    await service.claimChannel(state.channelId, state.callId);
    expect(
      (await service.getActiveCallsForChannels([state.channelId])).get(
        state.channelId,
      )?.callId,
    ).toBe(state.callId);

    await service.stopRinging([callee], state.callId);
    expect(await service.ringingCallIdsFor(callee)).toEqual([]);
    await service.delete(state.callId, state.channelId, true, [callee]);
    expect(await service.activeCallIds()).not.toContain(state.callId);
    expect(await service.getMany([state.callId])).toEqual([]);
  });

  it("acquireFinalize is true exactly once per call", async () => {
    if (!redisAvailable) return;
    const id = randomUUID();
    const results = await Promise.all([
      service.acquireFinalize(id),
      service.acquireFinalize(id),
      service.acquireFinalize(id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("delete() is a no-op for an already-gone call", async () => {
    if (!redisAvailable) return;
    await expect(
      service.delete(randomUUID(), randomUUID(), true),
    ).resolves.toBeUndefined();
  });
});
