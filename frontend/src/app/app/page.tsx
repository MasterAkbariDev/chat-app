import { MessageCircleHeart } from "lucide-react";

// Desktop-only: the list itself lives in the persistent sidebar (AppShell),
// so this route's content is just the reading-pane placeholder until a
// conversation is opened. On mobile this route shows the list instead
// (AppShell swaps visibility, nothing here is duplicated).
export default function ChatsIndexPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-canvas p-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-[var(--radius-lg)] bg-accent-soft text-accent-text">
        <MessageCircleHeart className="size-7" strokeWidth={1.8} aria-hidden />
      </div>
      <h1 className="font-display text-[22px] font-bold tracking-[-0.01em]">Pick up where you left off</h1>
      <p className="max-w-[320px] text-[14.5px] leading-relaxed text-muted">
        Choose a conversation from the list, or start a new one with the pencil button.
      </p>
      <p className="mt-2 text-[13px] text-muted">
        Press <kbd className="rounded-[6px] border border-line bg-panel px-1.5 py-0.5 text-[12px] font-semibold text-fg-2">Ctrl</kbd>{" "}
        <kbd className="rounded-[6px] border border-line bg-panel px-1.5 py-0.5 text-[12px] font-semibold text-fg-2">K</kbd> to jump anywhere.
      </p>
    </div>
  );
}
