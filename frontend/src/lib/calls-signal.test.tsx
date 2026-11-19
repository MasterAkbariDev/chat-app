import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { renderRingSamples } from "./ringtone";
import { shouldReplaceIncoming, type IncomingCall } from "@/contexts/call-context";
import { describeSystemMessage, formatCallMinutes } from "./system-message";

// A fake socket store for `useRealtimeEvent` — stands in for lib/socket.ts.
const store = vi.hoisted(() => {
  type Handler = (...a: unknown[]) => void;
  class FakeSocket {
    handlers = new Map<string, Set<Handler>>();
    on(ev: string, h: Handler) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
      this.handlers.get(ev)!.add(h);
    }
    off(ev: string, h: Handler) {
      this.handlers.get(ev)?.delete(h);
    }
    fire(ev: string, ...args: unknown[]) {
      for (const h of this.handlers.get(ev) ?? []) h(...args);
    }
  }
  const listeners = new Set<() => void>();
  return {
    FakeSocket,
    current: null as InstanceType<typeof FakeSocket> | null,
    set(s: InstanceType<typeof FakeSocket> | null) {
      this.current = s;
      for (const l of listeners) l();
    },
    listeners,
  };
});

vi.mock("@/lib/socket", () => ({
  getSocket: () => store.current,
  peekSocket: () => store.current,
  subscribeSocket: (l: () => void) => {
    store.listeners.add(l);
    return () => store.listeners.delete(l);
  },
}));

const { useRealtimeEvent } = await import("@/hooks/use-realtime-event");

function Listener({ onRing }: { onRing: (p: unknown) => void }) {
  useRealtimeEvent("call:ringing", onRing as never);
  return null;
}

describe("useRealtimeEvent follows the socket instance", () => {
  it("a listener mounted before sign-in still hears events once the socket exists (calls rang nowhere before)", () => {
    store.set(null);
    const onRing = vi.fn();
    render(<Listener onRing={onRing} />);

    const first = new store.FakeSocket();
    act(() => store.set(first));
    first.fire("call:ringing", { callId: "a" });
    expect(onRing).toHaveBeenCalledWith({ callId: "a" });

    // Sign out → sign in again in the same tab: moves to the new socket.
    const second = new store.FakeSocket();
    act(() => store.set(second));
    expect(first.handlers.get("call:ringing")?.size ?? 0).toBe(0);
    second.fire("call:ringing", { callId: "b" });
    expect(onRing).toHaveBeenLastCalledWith({ callId: "b" });
  });
});

describe("incoming ring replacement", () => {
  const ring = (callId: string, expiresAt?: number): IncomingCall => ({
    callId,
    channelId: "c",
    fromUserId: "u",
    fromUsername: "U",
    isPrivate: true,
    expiresAt,
  });

  it("a stale ring (its call:ended never arrived) doesn't block a new call", () => {
    expect(shouldReplaceIncoming(null, ring("a"))).toBe(true);
    expect(shouldReplaceIncoming(ring("a", 1_000), ring("b"), 2_000)).toBe(true);
    expect(shouldReplaceIncoming(ring("a", 5_000), ring("b"), 2_000)).toBe(false);
    expect(shouldReplaceIncoming(ring("a", 1_000), ring("a"), 2_000)).toBe(false);
  });
});

describe("ringtone", () => {
  it("renders one audible 2 s cycle that ends in silence (loopable without timers)", () => {
    const s = renderRingSamples(8_000);
    expect(s.length).toBe(16_000);
    expect(Math.max(...s.slice(0, 4_000).map(Math.abs))).toBeGreaterThan(0.05);
    expect(Math.max(...s.slice(12_000).map(Math.abs))).toBe(0);
  });
});

describe("voice chat service messages", () => {
  it("describes start and end", () => {
    expect(describeSystemMessage({ content: "voice_chat_started", metadata: null }, "Maya")).toBe("Maya started a voice chat");
    expect(describeSystemMessage({ content: "voice_chat_ended", metadata: { durationMinutes: 12 } }, "Maya")).toBe("Voice chat ended · 12 min");
    expect(describeSystemMessage({ content: "voice_chat_ended", metadata: null }, "Maya")).toBe("Voice chat ended");
    expect(formatCallMinutes(65)).toBe("1 h 5 min");
    expect(formatCallMinutes(120)).toBe("2 h");
  });
});
