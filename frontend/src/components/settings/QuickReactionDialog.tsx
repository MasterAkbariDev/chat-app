"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { BaseEmojiGrid } from "@/components/packs/StickerEmojiPicker";
import { PackImage } from "@/components/packs/PackImage";
import { Dialog } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAuth } from "@/contexts/auth-context";
import { ApiError } from "@/lib/api/client";
import { getMyPacks, getPack } from "@/lib/api/packs";
import { updateQuickReaction } from "@/lib/api/users";
import type { Me, PackItem } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { EMOJI_CATEGORIES } from "@/lib/emoji-data";

export interface QuickReactionDialogProps {
  onClose: () => void;
}

/** The current quick reaction, animated when it's a pack item. */
export function QuickReactionGlyph({
  user,
  size = 20,
}: {
  user: Pick<Me, "quickReaction" | "quickReactionItem">;
  size?: number;
}) {
  const item = user.quickReactionItem;
  if (item) {
    return (
      <PackImage
        thumbPath={item.thumbPath || item.relativePath}
        stillPath={item.stillPath || undefined}
        alt={`Animated ${user.quickReaction}`}
        className="inline-block object-contain align-middle"
        style={{ width: size + 4, height: size + 4 }}
      />
    );
  }
  return (
    <span
      className="leading-none"
      style={{ fontSize: size }}
      role="img"
      aria-label={user.quickReaction || "👍"}
    >
      {user.quickReaction || "👍"}
    </span>
  );
}

type Choice = { emoji: string } | { item: PackItem; packId: string };

/** The reactions people pick most, shown first (Telegram's "Popular"). */
const POPULAR = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉", "👏", "😍", "🥰", "🤔", "😁", "🤯", "💯", "👎"];

const cellClass =
  "pressable flex aspect-square w-full items-center justify-center rounded-[var(--radius-sm)] hover:bg-sunken focus-visible:bg-sunken";

// The reaction a double-tap on a message sends (see MessageBubble's
// `quickReactionEmoji` / `quickReactionItem` props): any regular emoji, or an
// animated emoji from a pack you've added.
export function QuickReactionDialog({ onClose }: QuickReactionDialogProps) {
  const { user, updateUser } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const mineQuery = useQuery({
    queryKey: ["packs", "mine", "emoji"],
    queryFn: () => getMyPacks("emoji"),
  });
  const mine = mineQuery.data ?? [];
  const details = useQueries({
    queries: mine.map((pack) => ({
      queryKey: ["packs", "detail", pack.id],
      queryFn: () => getPack(pack.id),
    })),
  });

  const mutation = useMutation({
    mutationFn: (choice: Choice) =>
      updateQuickReaction(
        "emoji" in choice
          ? { emoji: choice.emoji }
          : { packItemId: choice.item.id },
      ),
    onSuccess: (_res, choice) => {
      if ("emoji" in choice)
        updateUser({ quickReaction: choice.emoji, quickReactionItem: null });
      else {
        const { item, packId } = choice;
        updateUser({
          quickReaction:
            item.keywords.find((k) => /\p{Extended_Pictographic}/u.test(k)) ??
            user?.quickReaction ??
            "👍",
          quickReactionItem: {
            packItemId: item.id,
            packId,
            relativePath: item.relativePath,
            thumbPath: item.thumbPath ?? item.relativePath,
            stillPath: item.stillPath ?? "",
          },
        });
      }
      onClose();
    },
    onError: (err) =>
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't save that reaction. Check your connection and try again.",
      ),
  });

  const pick = (choice: Choice) => {
    setError(null);
    mutation.mutate(choice);
  };
  const currentItemId = user?.quickReactionItem?.packItemId;
  const currentEmoji = currentItemId ? null : (user?.quickReaction ?? "👍");

  // Category bar: tapping a tab marks it active at once and jumps there instantly; while the
  // user scrolls, the tab follows the section at the top (ignored briefly after a tap).
  const tabs = [
    { key: "popular", label: "Popular", glyph: "⭐" },
    ...(mine.length ? [{ key: "animated", label: "Animated", glyph: "✨" }] : []),
    ...EMOJI_CATEGORIES.map((c) => ({
      key: c.label,
      label: c.label,
      glyph: c.label === "Symbols" ? "🔣" : c.emoji[0],
    })),
  ];
  const [active, setActive] = useState("popular");
  // Telegram shows a pack's own emoji on its tab.
  const animatedIcon = details[0]?.data?.items?.[0];
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const lockUntil = useRef(0);
  const scroller = () => rootRef.current?.closest<HTMLElement>(".overflow-y-auto") ?? null;

  const keepTabVisible = (key: string) => {
    const strip = barRef.current;
    const tab = strip?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(key)}"]`);
    if (!strip || !tab) return;
    const left = tab.offsetLeft - strip.clientWidth / 2 + tab.offsetWidth / 2;
    strip.scrollTo({ left, behavior: "auto" });
  };

  // Event timestamps share one clock (DOMHighResTimeStamp), for the tap → scroll lock.
  const goTo = (key: string, at: number) => {
    setActive(key);
    keepTabVisible(key);
    lockUntil.current = at + 400;
    const sc = scroller();
    const section = rootRef.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(key)}"]`);
    if (!sc || !section) return;
    const barHeight = barRef.current?.offsetHeight ?? 0;
    sc.scrollTop += section.getBoundingClientRect().top - sc.getBoundingClientRect().top - barHeight;
  };

  useEffect(() => {
    const sc = scroller();
    if (!sc) return;
    const onScroll = (e: Event) => {
      if (e.timeStamp < lockUntil.current) return;
      const line = sc.getBoundingClientRect().top + (barRef.current?.offsetHeight ?? 0) + 8;
      let current = "popular";
      rootRef.current?.querySelectorAll<HTMLElement>("[data-section]").forEach((el) => {
        if (el.getBoundingClientRect().top <= line) current = el.dataset.section ?? current;
      });
      setActive((prev) => {
        if (prev !== current) keepTabVisible(current);
        return current;
      });
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
  }, [mine.length]);

  return (
    <Dialog
      onClose={onClose}
      size="md"
      title="Quick reaction"
      description={
        <>
          Double-tap a message to react with it. Current:{" "}
          {user ? <QuickReactionGlyph user={user} size={18} /> : null}
        </>
      }
      bodyClassName="px-2 py-0"
    >
      <div
        ref={rootRef}
        aria-busy={mutation.isPending || undefined}
        className={
          mutation.isPending ? "pointer-events-none opacity-60" : undefined
        }
      >
        {error ? (
          <p role="alert" className="px-3 pt-3 text-[13px] text-danger">
            {error}
          </p>
        ) : null}
        {mutation.isPending ? (
          <p role="status" className="px-3 pt-3 text-[13px] text-muted">
            Saving…
          </p>
        ) : null}

        <div
          ref={barRef}
          role="tablist"
          aria-label="Categories"
          className="sticky top-0 z-[2] -mx-2 flex gap-1 overflow-x-auto border-b border-line bg-raised px-3 py-1.5 [scrollbar-width:none]"
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              data-tab={tab.key}
              aria-selected={active === tab.key}
              aria-label={tab.label}
              title={tab.label}
              onClick={(e) => goTo(tab.key, e.timeStamp)}
              className={cn(
                "pressable flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[20px] leading-none hover:bg-sunken",
                active === tab.key && "bg-accent-soft ring-1 ring-accent/40",
              )}
            >
              {tab.key === "animated" && animatedIcon ? (
                <PackImage
                  thumbPath={animatedIcon.thumbPath ?? animatedIcon.relativePath}
                  stillPath={animatedIcon.stillPath}
                  alt=""
                  className="size-7 object-contain"
                />
              ) : (
                <span aria-hidden>{tab.glyph}</span>
              )}
            </button>
          ))}
        </div>

        <section aria-label="Popular" data-section="popular" className="px-3 pt-2">
          <h3 className="sticky top-[53px] z-[1] -mx-3 bg-raised px-3 py-1.5 text-[12.5px] font-semibold text-muted">
            Popular
          </h3>
          <div className="grid grid-cols-8 gap-0.5">
            {POPULAR.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={e}
                aria-pressed={currentEmoji === e}
                onClick={() => pick({ emoji: e })}
                className={cn(
                  cellClass,
                  "text-[22px] leading-none",
                  currentEmoji === e && "bg-accent-soft ring-1 ring-accent/40",
                )}
              >
                <span aria-hidden>{e}</span>
              </button>
            ))}
          </div>
        </section>

        <section aria-label="Animated" data-section="animated" className={cn("px-3 pt-2", mine.length === 0 && !mineQuery.isPending && "pb-1")}>
          <h3 className="sticky top-[53px] z-[1] -mx-3 bg-raised px-3 py-1.5 text-[12.5px] font-semibold text-muted">
            Animated
          </h3>
          {mineQuery.isPending ? (
            <div className="grid grid-cols-8 gap-0.5" aria-hidden>
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton
                  key={i}
                  className="aspect-square rounded-[var(--radius-sm)]"
                />
              ))}
            </div>
          ) : mine.length === 0 ? (
            <p className="pb-1 text-[13px] text-muted">
              Add an animated emoji pack to use one here.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {mine.map((pack, i) => {
                const items = details[i]?.data?.items;
                return (
                  <div key={pack.id} role="group" aria-label={pack.name}>
                    <div className="truncate px-1 pb-0.5 text-[12px] text-muted">
                      {pack.name}
                    </div>
                    <div className="grid grid-cols-8 gap-0.5">
                      {items
                        ? items.map((item) => {
                            const selected = item.id === currentItemId;
                            const label =
                              item.keywords.slice(0, 3).join(", ") ||
                              "Animated emoji";
                            return (
                              <button
                                key={item.id}
                                type="button"
                                aria-label={`Animated emoji: ${label}`}
                                aria-pressed={selected}
                                title={label}
                                onClick={() => pick({ item, packId: pack.id })}
                                className={cn(
                                  "pressable flex aspect-square w-full items-center justify-center rounded-[var(--radius-sm)] p-1 hover:bg-sunken focus-visible:bg-sunken",
                                  selected &&
                                    "bg-accent-soft ring-1 ring-accent/40",
                                )}
                              >
                                <PackImage
                                  thumbPath={
                                    item.thumbPath ?? item.relativePath
                                  }
                                  stillPath={item.stillPath}
                                  alt=""
                                  className="size-full object-contain"
                                />
                              </button>
                            );
                          })
                        : Array.from({ length: 8 }, (_, k) => (
                            <Skeleton
                              key={k}
                              className="aspect-square rounded-[var(--radius-sm)]"
                            />
                          ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <BaseEmojiGrid
          onPick={(char) => pick({ emoji: char })}
          selected={currentEmoji}
          headingTopClass="top-[53px]"
        />
      </div>
    </Dialog>
  );
}
