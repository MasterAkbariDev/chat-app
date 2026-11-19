"use client";

import { RotateCw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { MediaSendJob } from "./use-media-send-queue";

/** Compact rows above the composer while edited media uploads: what, how far, cancel / retry. */
export function MediaSendProgress({ jobs, onCancel, onRetry }: { jobs: MediaSendJob[]; onCancel: (id: string) => void; onRetry: (id: string) => void }) {
  if (!jobs.length) return null;
  return (
    <div className="mx-auto mb-2 flex max-w-[860px] flex-col gap-1.5" aria-live="polite">
      {jobs.map((j) => {
        const failed = j.status === "failed";
        const text = failed
          ? (j.error ?? "Couldn't send")
          : j.status === "queued"
            ? "Waiting…"
            : j.status === "processing"
              ? "Processing…"
              : j.status === "sending"
                ? "Sending…"
                : `Uploading ${Math.round(j.progress * 100)}%`;
        return (
          <div key={j.id} className={cn("fade-in flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-1.5", failed ? "bg-danger-soft" : "bg-sunken")}>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2 text-[13.5px]">
                <span dir="auto" className="truncate font-semibold text-fg">
                  {j.label}
                </span>
                <span className={cn("tabular shrink-0 text-[12.5px]", failed ? "text-danger" : "text-muted")}>{text}</span>
              </div>
              {!failed ? (
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={`Sending ${j.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(j.progress * 100)}>
                  <div
                    className={cn("h-full rounded-full bg-accent transition-[width] duration-200", (j.status === "processing" || j.status === "sending") && "animate-pulse")}
                    style={{ width: `${Math.max(4, j.progress * 100)}%` }}
                  />
                </div>
              ) : null}
            </div>
            {failed ? (
              <button type="button" onClick={() => onRetry(j.id)} aria-label={`Retry sending ${j.label}`} title="Retry" className="pressable flex size-9 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-line">
                <RotateCw className="size-[18px]" strokeWidth={2} />
              </button>
            ) : null}
            <button type="button" onClick={() => onCancel(j.id)} aria-label={`Cancel sending ${j.label}`} title="Cancel" className="pressable flex size-9 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-line">
              <X className="size-[18px]" strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
