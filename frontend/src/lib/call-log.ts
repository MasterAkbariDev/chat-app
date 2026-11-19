/** A `voice_call` message's `content` is JSON, not plain text — the backend
 * writes exactly one of these per call (calls.service.ts's `finalizeCall`),
 * describing the whole call's outcome rather than a per-participant event. */
export interface CallLog {
  kind: "missed" | "declined" | "ended";
  durationMinutes?: number;
}

export function parseCallLog(content: string): CallLog | null {
  try {
    const parsed = JSON.parse(content) as { callLog?: boolean; kind?: string; durationMinutes?: number };
    if (!parsed?.callLog) return null;
    if (parsed.kind !== "missed" && parsed.kind !== "declined" && parsed.kind !== "ended") return null;
    return { kind: parsed.kind, durationMinutes: typeof parsed.durationMinutes === "number" ? parsed.durationMinutes : undefined };
  } catch {
    return null;
  }
}

/** `isInitiator`: the viewer is the one who started the call (always the
 * message's own sender — calls.service.ts's `finalizeCall` posts it as the
 * initiator) — "No answer"/"You declined" read better than the generic
 * other-facing copy in that case. */
export function describeCallLog(log: CallLog, isInitiator: boolean): string {
  switch (log.kind) {
    case "missed":
      return isInitiator ? "No answer" : "Missed call";
    case "declined":
      return isInitiator ? "Call declined" : "You declined";
    case "ended":
      return log.durationMinutes ? `Call ended · ${log.durationMinutes}m` : "Call ended";
  }
}
