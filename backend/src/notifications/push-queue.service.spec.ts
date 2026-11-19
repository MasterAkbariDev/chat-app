/* eslint-disable @typescript-eslint/require-await */
import { PushQueueService } from "./push-queue.service";

type Row = {
  _id: string;
  token: string;
  userId: string;
  notification: { title: string; body: string };
  data: Record<string, string>;
  web: null;
  attempts: number;
  nextAttemptAt: Date;
};

/** A tiny stand-in for the Mongo model: just the calls the queue makes. */
function fakeModel(initial: Row[] = []) {
  const rows = [...initial];
  const model = {
    rows,
    insertMany: jest.fn(async (docs: Record<string, unknown>[]) => {
      docs.forEach((d, i) =>
        rows.push({ ...d, _id: `id${rows.length + i}` } as unknown as Row),
      );
    }),
    find: jest.fn(() => ({
      sort: () => ({
        limit: () => ({
          lean: () => ({
            exec: async () => rows.filter(r => r.nextAttemptAt <= new Date()),
          }),
        }),
      }),
    })),
    deleteOne: jest.fn((filter: { _id: string }) => ({
      exec: async () => {
        const i = rows.findIndex(r => r._id === filter._id);
        if (i >= 0) rows.splice(i, 1);
      },
    })),
    updateOne: jest.fn(
      (filter: { _id: string }, update: { $set: Partial<Row> }) => ({
        exec: async () => {
          const row = rows.find(r => r._id === filter._id);
          if (row) Object.assign(row, update.$set);
        },
      }),
    ),
  };
  return model;
}

function fakeFcm(sendResults: unknown[] = [], degraded = false) {
  return {
    isConfigured: true,
    isDegraded: degraded,
    probe: jest.fn(async () => true),
    send: jest.fn(
      async () => sendResults.shift() ?? { ok: true, invalidToken: false },
    ),
  };
}

const item = {
  token: "t1",
  userId: "u1",
  notification: { title: "A", body: "hi" },
  data: { channelId: "c" },
  web: { tag: "chat-c", link: "/app/c/c" },
};

describe("PushQueueService", () => {
  it("stores queued pushes with a 24 h expiry and no attempts yet", async () => {
    const model = fakeModel();
    const svc = new PushQueueService(model as never, fakeFcm() as never);
    await svc.enqueue([item]);
    expect(model.insertMany).toHaveBeenCalledTimes(1);
    const [doc] = model.insertMany.mock.calls[0][0] as unknown as {
      attempts: number;
      expiresAt: Date;
    }[];
    expect(doc.attempts).toBe(0);
    expect(doc.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
  });

  it("sends due pushes and removes the ones that went out", async () => {
    const model = fakeModel([
      {
        _id: "a",
        token: "t1",
        userId: "u1",
        notification: { title: "A", body: "hi" },
        data: {},
        web: null,
        attempts: 0,
        nextAttemptAt: new Date(0),
      },
    ]);
    const fcm = fakeFcm([{ ok: true, invalidToken: false }]);
    await new PushQueueService(model as never, fcm as never).drain();
    expect(fcm.send).toHaveBeenCalledTimes(1);
    expect(model.rows).toHaveLength(0);
  });

  it("backs off a transient failure instead of dropping it", async () => {
    const model = fakeModel([
      {
        _id: "a",
        token: "t1",
        userId: "u1",
        notification: { title: "A", body: "hi" },
        data: {},
        web: null,
        attempts: 0,
        nextAttemptAt: new Date(0),
      },
    ]);
    const fcm = fakeFcm([{ ok: false, invalidToken: false, transient: true }]);
    await new PushQueueService(model as never, fcm as never).drain();
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].attempts).toBe(1);
    expect(model.rows[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("drops a push for a dead token", async () => {
    const model = fakeModel([
      {
        _id: "a",
        token: "t1",
        userId: "u1",
        notification: { title: "A", body: "hi" },
        data: {},
        web: null,
        attempts: 0,
        nextAttemptAt: new Date(0),
      },
    ]);
    const fcm = fakeFcm([{ ok: false, invalidToken: true }]);
    await new PushQueueService(model as never, fcm as never).drain();
    expect(model.rows).toHaveLength(0);
  });

  it("while FCM is degraded, waits for a successful probe before sending anything", async () => {
    const model = fakeModel([
      {
        _id: "a",
        token: "t1",
        userId: "u1",
        notification: { title: "A", body: "hi" },
        data: {},
        web: null,
        attempts: 0,
        nextAttemptAt: new Date(0),
      },
    ]);
    const fcm = fakeFcm([], true);
    fcm.probe.mockResolvedValueOnce(false);
    await new PushQueueService(model as never, fcm as never).drain();
    expect(fcm.probe).toHaveBeenCalled();
    expect(fcm.send).not.toHaveBeenCalled();
    expect(model.rows).toHaveLength(1);
  });
});
