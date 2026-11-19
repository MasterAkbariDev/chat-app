import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton rounded-md", className)} />;
}

export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("flex items-center gap-3 px-3 py-2.5", className)}>
      <Skeleton className="size-12 shrink-0 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="h-2.5 w-4/5" />
      </div>
    </div>
  );
}

export function SkeletonList({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={className}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
