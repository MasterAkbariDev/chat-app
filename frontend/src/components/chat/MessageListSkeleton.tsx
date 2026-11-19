import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";

type Placeholder = { own: boolean; w: string; h: string; media?: boolean; joined?: boolean; tall?: boolean };

// A plausible conversation shape: runs from each side, a mix of short and
// long lines, and photo-sized blocks. Fixed (not random) so the first paint is
// identical on server and client and doesn't jitter on re-render. `tall` rows
// only show on taller screens, so the stack never overflows the feed and
// stays bottom-anchored like the real one.
const ROWS: Placeholder[] = [
  { own: false, w: "w-[44%]", h: "h-10", tall: true },
  { own: false, w: "w-[58%]", h: "h-14", joined: true, tall: true },
  { own: true, w: "w-[36%]", h: "h-10" },
  { own: false, w: "w-[min(60%,260px)]", h: "h-36", media: true },
  { own: false, w: "w-[28%]", h: "h-10", joined: true },
  { own: true, w: "w-[50%]", h: "h-14" },
  { own: true, w: "w-[min(55%,220px)]", h: "h-32", media: true, joined: true, tall: true },
  { own: false, w: "w-[40%]", h: "h-10" },
  { own: true, w: "w-[30%]", h: "h-10" },
];

/** Placeholder bubbles shown while a conversation's first page loads. The
 * pulse comes from `.skeleton` and stops under Reduce motion / Lite mode
 * (the global motion kill-switch). Bottom-anchored like the real feed. */
export function MessageListSkeleton({ className }: { className?: string }) {
  return (
    <div role="status" aria-label="Loading messages" className={cn("mx-auto flex w-full max-w-[860px] flex-col py-4", className)}>
      <Skeleton className="mx-auto mb-4 h-6 w-24 rounded-full" />
      {ROWS.map((r, i) => (
        <div
          key={i}
          className={cn("flex", r.own ? "justify-end" : "justify-start", i === 0 ? "" : r.joined ? "mt-1" : "mt-3", r.tall && "[@media(max-height:820px)]:hidden")}
        >
          <Skeleton
            className={cn(
              r.w,
              r.h,
              "max-w-[400px] rounded-[var(--radius-bubble)]",
              // Sender-side corner tightens, like a real run of bubbles.
              r.own ? "rounded-ee-md" : "rounded-es-md",
              r.media && "min-w-[160px]",
            )}
          />
        </div>
      ))}
    </div>
  );
}
