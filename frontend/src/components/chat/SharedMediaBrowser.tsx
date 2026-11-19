"use client";

/* eslint-disable @next/next/no-img-element -- backend-hosted message media */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Copy, Download, ImageOff, Link2, MessageSquareText, Pause, Play } from "lucide-react";
import { useRouter } from "@/hooks/use-app-router";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { ListItem } from "@/components/ui/List";
import { Menu, useLongPress, type MenuItem } from "@/components/ui/Menu";
import { Skeleton, SkeletonRow } from "@/components/ui/Skeleton";
import { copyText } from "@/components/chat/message-touch";
import { MediaPlaceholder } from "@/components/media/BubbleMedia";
import { FileMessage } from "@/components/media/FileMessage";
import { GifImage } from "@/components/media/GifImage";
import { MediaViewer, type MediaViewerItem } from "@/components/media/MediaViewer";
import { MusicMessage } from "@/components/media/MusicMessage";
import { VoicePlayer } from "@/components/media/VoicePlayer";
import { useAuth } from "@/contexts/auth-context";
import { usePerformance } from "@/contexts/performance-context";
import { getCommonGroups, getSharedCounts, getSharedItems, sharedCountsKey, sharedListKey, SHARED_KINDS, type CommonGroup, type SharedItemsPage, type SharedKind } from "@/lib/api/profile";
import { cn } from "@/lib/cn";
import { startDownload } from "@/lib/file-transfers";
import { mediaFileName, resolveAttachmentUrl, thumbImageSources } from "@/lib/media-src";
import { videoPosterUrl } from "@/lib/media-url";
import { musicTrackId } from "@/lib/music";
import * as playback from "@/lib/playback";
import { formatDuration } from "@/lib/recording";
import {
  displayUrl,
  explodeSharedPages,
  groupByMonth,
  hostOf,
  linksIn,
  listResolver,
  recallSharedTab,
  rememberSharedTab,
  sharedFileName,
  sharedMusicTrack,
  sharedSenderName,
  sharedViewerItems,
  sharedVoiceTrack,
  type SharedItem,
  type SharedTab,
} from "@/lib/shared-media";

const PAGE = 60;

const LABELS: Record<SharedTab, string> = { media: "Media", files: "Files", music: "Music", voice: "Voice", links: "Links", gifs: "GIFs", groups: "Groups" };
const EMPTY_COPY: Record<SharedKind, string> = {
  media: "No photos or videos yet.",
  files: "No files yet.",
  music: "No music yet.",
  voice: "No voice messages yet.",
  links: "No links yet.",
  gifs: "No GIFs yet.",
};

const messageHref = (channelId: string, id: string) => `/app/c/${channelId}?message=${encodeURIComponent(id)}`;

function shortDate(iso: string) {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "Omid · Oct 3" under a row. */
function byLine(it: SharedItem, currentUserId?: string) {
  return `${sharedSenderName(it.message, currentUserId)} · ${shortDate(it.createdAt)}`;
}

export interface SharedMediaBrowserProps {
  channelId: string;
  /** A person's profile: also the "Groups" tab (groups you're both in). */
  commonWithUserId?: string;
  className?: string;
}

/**
 * A chat's shared media, Telegram-style: under the profile/info it takes the rest of the
 * page, its tab bar sticks under the page header while you scroll, and each tab lists ITEMS
 * (an album's photos are separate cells) newest first, in month sections, loading older ones
 * as you reach the end. Tabs with nothing in them are hidden; the last one you opened is
 * remembered per chat. Media/GIFs open the full-screen viewer over everything on the tab.
 *
 * Lay it out full-width: it breaks out of a narrower column up to 720px when its scroll
 * container is a CSS container (`@container`).
 */
export function SharedMediaBrowser({ channelId, commonWithUserId, className }: SharedMediaBrowserProps) {
  const countsQuery = useQuery({ queryKey: sharedCountsKey(channelId), queryFn: () => getSharedCounts(channelId) });
  const groupsQuery = useQuery({
    queryKey: ["chats", "common", commonWithUserId ?? ""],
    queryFn: () => getCommonGroups(commonWithUserId!),
    enabled: !!commonWithUserId,
  });
  const counts = countsQuery.data;
  const groupCount = groupsQuery.data?.length ?? 0;
  const tabs = useMemo<SharedTab[]>(() => {
    if (!counts) return [];
    const kinds: SharedTab[] = SHARED_KINDS.filter((k) => (counts[k] ?? 0) > 0);
    return groupCount > 0 ? [...kinds, "groups"] : kinds;
  }, [counts, groupCount]);
  const [picked, setPicked] = useState<SharedTab | null>(() => (typeof window === "undefined" ? null : recallSharedTab(channelId)));
  const active = picked && tabs.includes(picked) ? picked : (tabs[0] ?? null);
  const tabRefs = useRef<Partial<Record<SharedTab, HTMLButtonElement | null>>>({});
  const rootRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Keep the chosen tab visible in the (scrollable) tab strip.
  useEffect(() => {
    if (active) tabRefs.current[active]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const choose = useCallback(
    (tab: SharedTab, focus = false) => {
      setPicked(tab);
      rememberSharedTab(channelId, tab);
      if (focus) tabRefs.current[tab]?.focus();
      // Switching while the bar is stuck: start the new tab at its top, like Telegram.
      const root = rootRef.current;
      const bar = barRef.current;
      if (root && bar && root.getBoundingClientRect().top < bar.getBoundingClientRect().top - 1) {
        root.scrollIntoView({ block: "start" });
      }
    },
    [channelId],
  );

  const breakout = "w-[min(100cqw,720px)] mx-[calc((100%_-_min(100cqw,720px))/2)]";

  if (countsQuery.isPending || (commonWithUserId && groupsQuery.isPending && !countsQuery.isError)) {
    return (
      <section aria-hidden className={cn(breakout, className)}>
        <div className="flex h-12 items-center gap-6 border-b border-line px-4">
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-12" />
        </div>
        <GridSkeleton />
      </section>
    );
  }
  if (countsQuery.isError) {
    return (
      <p className={cn("mx-4 rounded-[var(--radius-md)] border border-line bg-panel px-4 py-3 text-[14px] text-danger", className)}>
        Couldn&apos;t load shared media. Check your connection and reopen this page.
      </p>
    );
  }
  // Nothing shared: just the page's bottom breathing room.
  if (!active) return <div aria-hidden className="h-24 lg:h-10" />;

  function moveTab(delta: number) {
    const i = tabs.indexOf(active!);
    choose(tabs[(i + delta + tabs.length) % tabs.length], true);
  }

  return (
    <section
      ref={rootRef}
      aria-label="Shared media"
      // Fills the rest of the page so the tab bar can always reach the top.
      className={cn("@container flex min-h-[calc(100dvh-3.5rem)] scroll-mt-0 flex-col pb-24 lg:pb-10", breakout, className)}
    >
      <div
        ref={barRef}
        role="tablist"
        aria-label="Shared media"
        className="sticky top-0 z-[6] flex overflow-x-auto border-b border-line bg-canvas/95 backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onKeyDown={(e) => {
          const dir = getComputedStyle(e.currentTarget).direction === "rtl" ? -1 : 1;
          if (e.key === "ArrowRight") moveTab(dir);
          else if (e.key === "ArrowLeft") moveTab(-dir);
          else if (e.key === "Home") choose(tabs[0], true);
          else if (e.key === "End") choose(tabs[tabs.length - 1], true);
          else return;
          e.preventDefault();
        }}
      >
        {tabs.map((k) => {
          const selected = k === active;
          const n = k === "groups" ? groupCount : (counts?.[k] ?? 0);
          return (
            <button
              key={k}
              ref={(el) => {
                tabRefs.current[k] = el;
              }}
              type="button"
              role="tab"
              id={`shared-tab-${channelId}-${k}`}
              aria-selected={selected}
              aria-controls={`shared-panel-${channelId}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => choose(k)}
              className={cn(
                "focus-inset relative flex min-h-12 flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap px-4 text-[14.5px] font-semibold transition-colors duration-[var(--dur-fast)]",
                selected ? "text-accent-text" : "text-muted hover:text-fg",
              )}
            >
              {LABELS[k]}
              <span className="tabular text-[12.5px] font-medium opacity-75">{n.toLocaleString()}</span>
              <span
                aria-hidden
                className={cn("absolute inset-x-3 bottom-0 h-[3px] rounded-t-full bg-accent transition-opacity", selected ? "opacity-100" : "opacity-0")}
              />
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`shared-panel-${channelId}`} aria-labelledby={`shared-tab-${channelId}-${active}`} className="flex-1">
        {active === "groups" ? (
          <GroupsPanel groups={groupsQuery.data ?? []} />
        ) : active === "media" || active === "gifs" ? (
          <GridPanel key={active} channelId={channelId} kind={active} total={counts?.[active] ?? 0} />
        ) : (
          <ListPanel key={active} channelId={channelId} kind={active} />
        )}
      </div>
    </section>
  );
}

/* ───────────────────────── data ───────────────────────── */

function useSharedItems(channelId: string, kind: SharedKind) {
  const query = useInfiniteQuery({
    queryKey: sharedListKey(channelId, kind),
    queryFn: ({ pageParam }) => getSharedItems(channelId, kind, pageParam, PAGE),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = useMemo(() => explodeSharedPages(query.data?.pages ?? []), [query.data]);
  return { query, items };
}

/** Reads the tab's current list from the cache — for player resolvers that outlive the page. */
function useCachedItems(channelId: string, kind: SharedKind) {
  const queryClient = useQueryClient();
  return useCallback(
    () => explodeSharedPages(queryClient.getQueryData<InfiniteData<SharedItemsPage>>(sharedListKey(channelId, kind))?.pages ?? []),
    [queryClient, channelId, kind],
  );
}

/** Loads the next page as the list's end comes near. */
function useLoadMore(query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || isFetchingNextPage || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void fetchNextPage();
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return sentinel;
}

function LoadMore({ query, sentinel }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown; isFetchNextPageError: boolean }; sentinel: React.RefObject<HTMLDivElement | null> }) {
  return (
    <>
      <div ref={sentinel} aria-hidden />
      {query.hasNextPage ? (
        <div className="flex justify-center px-4 py-3">
          <Button variant="ghost" size="sm" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
            {query.isFetchNextPageError ? "Try again" : "Show more"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function MonthHeading({ label }: { label: string }) {
  return <h3 className="px-4 pb-2 pt-4 text-[13.5px] font-semibold text-muted first:pt-3">{label}</h3>;
}

const GRID = "grid grid-cols-3 gap-0.5 @min-[460px]:grid-cols-4 @min-[620px]:grid-cols-5";

function GridSkeleton({ cells = 12 }: { cells?: number }) {
  return (
    <div aria-hidden className={cn(GRID, "pt-0.5")}>
      {Array.from({ length: cells }, (_, i) => (
        <Skeleton key={i} className="aspect-square w-full rounded-none" />
      ))}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div aria-hidden className="pt-2">
      <SkeletonRow />
      <SkeletonRow />
      <SkeletonRow />
    </div>
  );
}

function PanelError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <p className="text-[14px] text-danger">Couldn&apos;t load these. Check your connection and try again.</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/* ───────────────────────── media & GIF grid ───────────────────────── */

function GridPanel({ channelId, kind, total }: { channelId: string; kind: "media" | "gifs"; total: number }) {
  const { user } = useAuth();
  const router = useRouter();
  const { query, items } = useSharedItems(channelId, kind);
  const sentinel = useLoadMore(query);
  const sections = useMemo(() => groupByMonth(items), [items]);
  const viewerItems = useMemo(() => sharedViewerItems(items, user?._id), [items, user?._id]);
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; item: SharedItem } | null>(null);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const showInChat = useCallback((messageId: string) => router.push(messageHref(channelId, messageId)), [router, channelId]);

  if (query.isPending) return <GridSkeleton />;
  if (query.isError) return <PanelError onRetry={() => query.refetch()} />;
  if (!items.length) return <p className="px-4 py-10 text-center text-[14px] text-muted">{EMPTY_COPY[kind]}</p>;

  const startIndex = viewerKey ? viewerItems.findIndex((v) => v.key === viewerKey) : -1;

  return (
    <div>
      {sections.map((s) => (
        <div key={s.key}>
          <MonthHeading label={s.label} />
          <ul className={GRID}>
            {s.items.map((it) => (
              <li key={it.key}>
                <GridCell item={it} currentUserId={user?._id} onOpen={() => setViewerKey(it.key)} onMenu={(x, y) => setMenu({ x, y, item: it })} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <LoadMore query={query} sentinel={sentinel} />

      {viewerKey && startIndex >= 0 ? (
        <MediaViewer
          items={viewerItems}
          startIndex={startIndex}
          total={total}
          onClose={() => setViewerKey(null)}
          onNearStart={loadOlder}
          onShowInChat={(v: MediaViewerItem) => {
            showInChat(v.messageId);
            setViewerKey(null);
          }}
        />
      ) : null}

      {menu ? (
        <Menu
          anchor={{ point: { x: menu.x, y: menu.y } }}
          aria-label={menu.item.isVideo ? "Video actions" : kind === "gifs" ? "GIF actions" : "Photo actions"}
          onClose={() => setMenu(null)}
          items={itemMenu(menu.item, () => showInChat(menu.item.message._id))}
        />
      ) : null}
    </div>
  );
}

function itemMenu(it: SharedItem, onShowInChat: () => void): MenuItem[] {
  const href = it.url ? resolveAttachmentUrl(it.url) : null;
  return [
    { key: "show", label: "Show in chat", icon: MessageSquareText, onSelect: onShowInChat },
    ...(href
      ? [
          { key: "download", label: "Download", icon: Download, onSelect: () => void startDownload(href, mediaFileName(it.url!)) },
          { key: "copy", label: "Copy link", icon: Copy, onSelect: () => void copyText(href) },
        ]
      : []),
  ];
}

function GridCell({ item, currentUserId, onOpen, onMenu }: { item: SharedItem; currentUserId?: string; onOpen: () => void; onMenu: (x: number, y: number) => void }) {
  const isGif = item.message.type === "gif";
  const kindWord = isGif ? "GIF" : item.isVideo ? "Video" : "Photo";
  const duration = item.isVideo ? (item.meta?.durationSec ?? item.message.durationSec) : null;
  const label = `${kindWord}, ${byLine(item, currentUserId)}${duration ? `, ${formatDuration(duration)}` : ""}`;
  const { firedRef, handlers } = useLongPress(onMenu);

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        if (firedRef.current) return;
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      {...handlers}
      className="pressable relative block aspect-square w-full overflow-hidden bg-sunken [-webkit-touch-callout:none]"
    >
      {isGif && item.url ? <GifCell url={item.url} blurhash={item.meta?.blurhash} /> : <Thumb item={item} />}
      {item.isVideo ? (
        <span aria-hidden className="absolute bottom-1 start-1 flex h-5 items-center gap-1 rounded-full bg-black/55 px-1.5 text-[11.5px] font-semibold text-white">
          <Play className="size-2.5 fill-current" strokeWidth={0} />
          {duration ? <span className="tabular">{formatDuration(duration)}</span> : null}
        </span>
      ) : null}
    </button>
  );
}

/** A photo's small variant (or a video's poster) over its blurhash; falls back step by step. */
function Thumb({ item }: { item: SharedItem }) {
  const { url, isVideo } = item;
  const posterUrl = item.meta?.posterUrl;
  const candidates = useMemo(() => {
    if (!url) return [];
    if (isVideo) {
      const poster = posterUrl ? resolveAttachmentUrl(posterUrl) : videoPosterUrl(resolveAttachmentUrl(url));
      return poster ? [poster] : [];
    }
    const s = thumbImageSources(url);
    return [...new Set([s.src, s.fallback, resolveAttachmentUrl(url)].filter((x): x is string => !!x))];
  }, [url, isVideo, posterUrl]);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = candidates[attempt];
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, [src]);

  return (
    <>
      {!loaded ? <MediaPlaceholder blurhash={item.meta?.blurhash} /> : null}
      {src ? (
        <img
          ref={imgRef}
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setAttempt((a) => a + 1)}
          className={cn("absolute inset-0 size-full object-cover transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
        />
      ) : !item.isVideo || attempt > 0 ? (
        <span className="absolute inset-0 flex items-center justify-center text-muted">
          <ImageOff className="size-5" strokeWidth={1.7} aria-hidden />
        </span>
      ) : null}
    </>
  );
}

/** A looping GIF cell: follows Motion & performance (plays while on screen, on hover, or
 *  stays still), like GIFs in the chat. */
function GifCell({ url, blurhash }: { url: string; blurhash?: string | null }) {
  const src = resolveAttachmentUrl(url);
  const isVideo = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src);
  return (
    <>
      <MediaPlaceholder blurhash={blurhash} />
      {isVideo ? <GifVideo src={src} /> : <GifImage src={src} alt="" className="absolute inset-0 size-full" mediaClassName="object-cover" />}
      <span aria-hidden className="pointer-events-none absolute start-1 top-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[10.5px] font-bold text-white">
        GIF
      </span>
    </>
  );
}

function GifVideo({ src }: { src: string }) {
  const { animatedMedia } = usePerformance();
  const ref = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const shouldPlay = visible && (animatedMedia === "auto" || (animatedMedia === "interact" && hover));

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const host = ref.current?.closest("button");
    if (!host) return;
    const on = () => setHover(true);
    const off = () => setHover(false);
    host.addEventListener("pointerenter", on);
    host.addEventListener("pointerleave", off);
    host.addEventListener("focus", on);
    host.addEventListener("blur", off);
    return () => {
      host.removeEventListener("pointerenter", on);
      host.removeEventListener("pointerleave", off);
      host.removeEventListener("focus", on);
      host.removeEventListener("blur", off);
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (shouldPlay) void el.play().catch(() => undefined);
    else el.pause();
  }, [shouldPlay]);

  return (
    <video
      ref={ref}
      // `#t=0.1` paints a first frame while paused (motion off).
      src={`${src}#t=0.1`}
      muted
      loop
      playsInline
      preload="metadata"
      aria-hidden
      onLoadedData={() => setLoaded(true)}
      className={cn("absolute inset-0 size-full object-cover transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
    />
  );
}

/* ───────────────────────── files, music, voice, links ───────────────────────── */

function ListPanel({ channelId, kind }: { channelId: string; kind: Exclude<SharedKind, "media" | "gifs"> }) {
  const { user } = useAuth();
  const { query, items } = useSharedItems(channelId, kind);
  const sentinel = useLoadMore(query);
  const sections = useMemo(() => groupByMonth(items), [items]);
  const cached = useCachedItems(channelId, kind);
  const me = user?._id;
  // Previous / next through this tab's list (the row below is "next").
  const musicAdjacent = useMemo(
    () =>
      listResolver(
        cached,
        (it) => sharedMusicTrack(it, me),
        (it) => musicTrackId(it.message._id, it.index),
      ),
    [cached, me],
  );
  const voiceNext = useMemo(() => {
    const r = listResolver(
      cached,
      (it) => (it.message.type === "voice" ? sharedVoiceTrack(it, me) : null),
      (it) => it.message._id,
    );
    return (id: string) => r(id, 1);
  }, [cached, me]);

  if (query.isPending) return <ListSkeleton />;
  if (query.isError) return <PanelError onRetry={() => query.refetch()} />;
  if (!items.length) return <p className="px-4 py-10 text-center text-[14px] text-muted">{EMPTY_COPY[kind]}</p>;

  return (
    <div>
      {sections.map((s) => (
        <div key={s.key}>
          <MonthHeading label={s.label} />
          <ul className="[&>li+li]:border-t [&>li+li]:border-line">
            {s.items.map((it) => (
              <li key={it.key} className="flex items-center gap-1 pe-1.5">
                <div className="min-w-0 flex-1 py-2.5 ps-4">
                  {kind === "files" ? (
                    <FileRow item={it} currentUserId={me} />
                  ) : kind === "music" ? (
                    <MusicRow item={it} currentUserId={me} resolveAdjacent={musicAdjacent} />
                  ) : kind === "voice" ? (
                    it.message.type === "video_note" ? (
                      <RoundRow item={it} currentUserId={me} />
                    ) : (
                      <VoiceRow item={it} currentUserId={me} resolveNext={voiceNext} />
                    )
                  ) : (
                    <LinkRow item={it} currentUserId={me} />
                  )}
                </div>
                <ShowInChat channelId={channelId} messageId={it.message._id} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <LoadMore query={query} sentinel={sentinel} />
    </div>
  );
}

function ShowInChat({ channelId, messageId }: { channelId: string; messageId: string }) {
  return (
    <Link
      href={messageHref(channelId, messageId)}
      aria-label="Show in chat"
      title="Show in chat"
      className="pressable flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-accent-soft hover:text-accent-text focus-visible:bg-accent-soft focus-visible:text-accent-text active:bg-accent-soft"
    >
      <MessageSquareText className="size-[18px]" strokeWidth={1.9} aria-hidden />
    </Link>
  );
}

function ByLine({ item, currentUserId, className }: { item: SharedItem; currentUserId?: string; className?: string }) {
  return (
    <span dir="auto" className={cn("block truncate text-[12.5px] text-muted", className)}>
      {byLine(item, currentUserId)}
    </span>
  );
}

function FileRow({ item, currentUserId }: { item: SharedItem; currentUserId?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <FileMessage id={item.message._id} url={item.url ?? undefined} meta={item.meta} originalFilename={sharedFileName(item)} className="w-full" />
      <ByLine item={item} currentUserId={currentUserId} className="ps-[60px]" />
    </div>
  );
}

function MusicRow({ item, currentUserId, resolveAdjacent }: { item: SharedItem; currentUserId?: string; resolveAdjacent: playback.AdjacentResolver }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <MusicMessage
        id={item.message._id}
        url={item.url ?? undefined}
        meta={item.meta}
        originalFilename={item.meta?.fileName ?? (item.index === 0 ? item.message.originalFilename : null)}
        durationSec={item.index === 0 ? item.message.durationSec : null}
        senderLabel={sharedSenderName(item.message, currentUserId)}
        createdAt={item.createdAt}
        channelId={item.message.channelId}
        currentUserId={currentUserId}
        trackIndex={item.index}
        resolveAdjacent={resolveAdjacent}
        className="w-full"
      />
      <ByLine item={item} currentUserId={currentUserId} className="ps-[60px]" />
    </div>
  );
}

function VoiceRow({ item, currentUserId, resolveNext }: { item: SharedItem; currentUserId?: string; resolveNext: (id: string) => playback.PlaybackTrack | null }) {
  const track = sharedVoiceTrack(item, currentUserId);
  if (!track) return <ByLine item={item} currentUserId={currentUserId} />;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span dir="auto" className="truncate text-[14px] font-semibold text-fg">
        {sharedSenderName(item.message, currentUserId)}
        <span className="font-normal text-muted"> · {shortDate(item.createdAt)}</span>
      </span>
      <VoicePlayer
        src={track.src}
        durationSec={item.message.durationSec}
        waveform={item.message.waveform}
        track={track}
        resolveNext={resolveNext}
        label={`Voice message from ${track.senderName}`}
        className="w-full max-w-[360px]"
      />
    </div>
  );
}

/** A round video message as a small circle; it plays in the floating circle (app-wide
 *  player), so it keeps playing while you scroll or leave the page. */
function RoundRow({ item, currentUserId }: { item: SharedItem; currentUserId?: string }) {
  const track = sharedVoiceTrack(item, currentUserId);
  const state = playback.usePlayback((s) => (track && s.track?.id === track.id ? s : null));
  const playing = !!state?.playing;
  const poster = item.url ? (item.meta?.posterUrl ? resolveAttachmentUrl(item.meta.posterUrl) : videoPosterUrl(resolveAttachmentUrl(item.url))) : undefined;
  const [posterFailed, setPosterFailed] = useState(false);
  const duration = state?.duration || item.message.durationSec || 0;
  const progress = state && duration ? Math.min(1, state.current / duration) : 0;

  function toggle() {
    if (!track) return;
    if (state) playback.toggle();
    else playback.play(track);
  }

  const size = 48;
  const r = size / 2 - 1.5;
  const c = 2 * Math.PI * r;
  return (
    <button type="button" onClick={toggle} disabled={!track} aria-label={`${playing ? "Pause" : "Play"} video message from ${sharedSenderName(item.message, currentUserId)}`} className="focus-ring flex w-full min-w-0 items-center gap-3 rounded-[var(--radius-sm)] text-start">
      <span className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-sunken">
        {poster && !posterFailed ? <img src={poster} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setPosterFailed(true)} className="absolute inset-0 size-full object-cover" /> : null}
        <span aria-hidden className="absolute inset-0 bg-black/25" />
        {playing ? <Pause className="relative size-5 fill-white text-white" strokeWidth={0} /> : <Play className="relative ms-0.5 size-5 fill-white text-white" strokeWidth={0} />}
        {state ? (
          <svg className="pointer-events-none absolute inset-0 -rotate-90 text-white" width={size} height={size} aria-hidden>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} />
          </svg>
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span dir="auto" className="block truncate text-[14px] font-semibold text-fg">
          {sharedSenderName(item.message, currentUserId)}
          <span className="font-normal text-muted"> · {shortDate(item.createdAt)}</span>
        </span>
        <span className="tabular mt-0.5 block text-[12.5px] text-muted">
          Video message{duration ? ` · ${state ? `${formatDuration(state.current)} / ` : ""}${formatDuration(duration)}` : ""}
        </span>
      </span>
    </button>
  );
}

function LinkRow({ item, currentUserId }: { item: SharedItem; currentUserId?: string }) {
  const links = linksIn(item.message.content);
  const first = links[0];
  const host = first ? hostOf(first) : null;
  // The text around the link(s), if there's more than the link itself.
  const rest = links.reduce((t, l) => t.replace(l, "").replace(displayUrl(l), ""), item.message.content).replace(/https?:\/\/\S+|www\.\S+/gi, "").trim();
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span aria-hidden className="mt-0.5 flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-accent-soft text-[18px] font-bold uppercase text-accent-text">
        {host ? host.charAt(0) : <Link2 className="size-5" strokeWidth={1.8} />}
      </span>
      <div className="min-w-0 flex-1">
        {first ? (
          <a href={first} target="_blank" rel="noopener noreferrer" className="block w-fit max-w-full truncate rounded-[6px] text-[15px] font-semibold text-fg transition-colors duration-[var(--dur-fast)] hover:text-accent-text focus-visible:text-accent-text">
            {host}
          </a>
        ) : null}
        {rest ? (
          <p dir="auto" className="mt-0.5 line-clamp-2 whitespace-pre-line break-words text-[13.5px] leading-snug text-fg-2">
            {rest}
          </p>
        ) : null}
        <ul className="mt-0.5">
          {links.slice(0, 4).map((l) => (
            <li key={l} className="min-w-0">
              <a href={l} target="_blank" rel="noopener noreferrer" dir="ltr" className="block w-fit max-w-full truncate rounded-[6px] text-[13.5px] text-accent-text decoration-accent/40 underline-offset-2 transition-colors duration-[var(--dur-fast)] hover:underline">
                {displayUrl(l)}
              </a>
            </li>
          ))}
        </ul>
        <ByLine item={item} currentUserId={currentUserId} className="mt-0.5" />
      </div>
    </div>
  );
}

/* ───────────────────────── groups in common ───────────────────────── */

function GroupsPanel({ groups }: { groups: CommonGroup[] }) {
  return (
    <ul className="pt-1 [&>li+li]:border-t [&>li+li]:border-line">
      {groups.map((g) => (
        <li key={g._id}>
          <ListItem
            leading={<Avatar colorId={g._id} name={g.name} src={g.image?.[0]} size={44} shape="square" />}
            title={<span dir="auto">{g.name}</span>}
            subtitle={`${g.memberCount.toLocaleString()} ${g.memberCount === 1 ? "member" : "members"}`}
            href={`/app/c/${g._id}`}
          />
        </li>
      ))}
    </ul>
  );
}
