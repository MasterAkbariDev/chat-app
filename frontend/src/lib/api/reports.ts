import { apiFetch } from "./client";

export type ReportTargetType = "message" | "user" | "channel";

export interface CreateReportInput {
  targetType: ReportTargetType;
  targetId: string;
  /** Free text, required, ≤100 chars — despite the backend's Swagger example
   * ("spam"), this is NOT an enum server-side (confirmed by reading
   * create-report.dto.ts). */
  reason: string;
  /** ≤1000 chars. */
  note?: string;
}

/** POST /v1/reports — 10/min per caller (confirmed `@Throttle`). Duplicate
 * reports (same reporter + targetType + targetId, no time window — it's a
 * permanent unique index, not a cooldown) 400 with "You've already reported
 * this". The target isn't looked up at all — reporting a well-formed but
 * nonexistent id still succeeds and lands in the moderation queue. */
export function createReport(input: CreateReportInput) {
  return apiFetch<{ _id: string }>("/v1/reports", { method: "POST", body: input });
}
