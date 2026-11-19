"use client";

import { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Film, ImageOff, Upload } from "lucide-react";
import { ChatWallpaper } from "@/components/chat/ChatWallpaper";
import { Button } from "@/components/ui/Button";
import { PageBody, PageHeader } from "@/components/ui/PageHeader";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { Skeleton } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { ApiError } from "@/lib/api/client";
import { CHANNELS_QUERY_KEY, getChannelsMine } from "@/lib/api/chats";
import { cn } from "@/lib/cn";
import { MediaEditor } from "@/components/media/editor/MediaEditor";
import {
  WALLPAPER_GLOBAL_QUERY_KEY,
  WALLPAPER_MAX_IMAGE_BYTES,
  WALLPAPER_MAX_VIDEO_BYTES,
  applyChatWallpaper,
  applyGlobalWallpaper,
  getChatWallpaper,
  getGlobalWallpaper,
  resetChatWallpaper,
  resetGlobalWallpaper,
  updateChatWallpaperSettings,
  updateGlobalWallpaperSettings,
  uploadWallpaperImage,
  uploadWallpaperVideo,
  type Wallpaper,
  type WallpaperFitMode,
  type WallpaperMedia,
  type WallpaperSettings,
} from "@/lib/api/wallpaper";
import { channelDisplayName } from "@/lib/api/types";

// Bundled SVG gradients (public/wallpapers/*.svg) — no upload involved, so
// these work regardless of whether this environment's media backend is up.
// Your own photo or video goes through POST /v2/wallpapers/upload/image|video
// and shows up as an extra "Your photo"/"Your video" tile in front of these.
const PRESETS = [
  { id: "indigo", label: "Indigo" },
  { id: "amber", label: "Amber" },
  { id: "emerald", label: "Emerald" },
  { id: "rose", label: "Rose" },
  { id: "slate", label: "Slate" },
  { id: "gold", label: "Gold" },
];

const FIT_OPTIONS: { key: WallpaperFitMode; label: string }[] = [
  { key: "cover", label: "Cover" },
  { key: "contain", label: "Contain" },
  { key: "stretch", label: "Stretch" },
];

const DEFAULT_SETTINGS: WallpaperSettings = { blur: 0, dim: 20, brightness: 100, fitMode: "cover" };

const presetUrl = (id: string) => `/wallpapers/${id}.svg`;
const isPresetUrl = (url: string) => PRESETS.some((p) => presetUrl(p.id) === url);

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp)$/i;

/** Client-side check before anything is sent: which upload endpoint, or a
 * readable reason it can't be used. The server sniffs the bytes anyway. */
function classifyFile(file: File): { kind: "image" | "video" } | { error: string } {
  const isVideo = file.type ? file.type.startsWith("video/") : VIDEO_EXT.test(file.name);
  const isImage = file.type ? file.type.startsWith("image/") && file.type !== "image/svg+xml" : IMAGE_EXT.test(file.name);
  if (isVideo) {
    if (file.size > WALLPAPER_MAX_VIDEO_BYTES) return { error: "That video is over 60 MB. Choose a shorter or smaller one." };
    return { kind: "video" };
  }
  if (isImage) {
    if (file.size > WALLPAPER_MAX_IMAGE_BYTES) return { error: "That photo is over 15 MB. Choose a smaller one." };
    return { kind: "image" };
  }
  return { error: "That file isn't a photo or a video. Choose a JPG, PNG, WebP, MP4 or MOV file." };
}

type UploadState = { kind: "image" | "video"; phase: "uploading" | "processing"; percent: number };

function uploadLabel(u: UploadState) {
  if (u.phase === "processing") return u.kind === "video" ? "Preparing your video…" : "Preparing your photo…";
  return `Uploading ${u.kind === "video" ? "video" : "photo"}… ${u.percent}%`;
}

/** A labelled range input: visible label + live value, both wired to the
 * control (label via htmlFor, value via aria-valuetext). */
function SliderRow({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[14px] font-semibold text-fg-2">
          {label}
        </label>
        <span className="tabular text-[13.5px] text-muted" aria-hidden>
          {value}
          {unit}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        aria-valuetext={`${value}${unit}`}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-6 w-full cursor-pointer accent-[var(--accent)]"
      />
    </div>
  );
}

/** Runs only the last `schedule`d callback, `ms` after the latest call;
 * anything still pending on unmount is sent then rather than dropped. */
function useTrailingDebounce(ms: number) {
  const pendingRef = useRef<{ timer: ReturnType<typeof setTimeout>; send: () => void } | null>(null);
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) {
        clearTimeout(pending.timer);
        pending.send();
      }
    },
    [],
  );
  return useMemo(
    () => ({
      schedule(send: () => void) {
        if (pendingRef.current) clearTimeout(pendingRef.current.timer);
        const timer = setTimeout(() => {
          pendingRef.current = null;
          send();
        }, ms);
        pendingRef.current = { timer, send };
      },
      cancel() {
        if (pendingRef.current) clearTimeout(pendingRef.current.timer);
        pendingRef.current = null;
      },
    }),
    [ms],
  );
}

function WallpaperSettingsPageInner() {
  const chatId = useSearchParams().get("chat");
  const queryClient = useQueryClient();
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Only fetched at all when scoped to a chat — this is the same list
  // ChatInfoPanel/ConversationView already share one cache entry for, just
  // here to resolve the chat's display name for the header.
  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine(), enabled: !!chatId });
  const channel = chatId ? channelsQuery.data?.items.find((c) => c.channelId === chatId) : undefined;

  const wallpaperQueryKey = chatId ? (["wallpaper", "chat", chatId] as const) : WALLPAPER_GLOBAL_QUERY_KEY;
  const wallpaperQuery = useQuery({
    queryKey: wallpaperQueryKey,
    queryFn: () => (chatId ? getChatWallpaper(chatId) : getGlobalWallpaper()),
  });
  const applied = wallpaperQuery.data ?? null;

  const [settings, setSettings] = useState<WallpaperSettings>(DEFAULT_SETTINGS);
  const [selected, setSelected] = useState<WallpaperMedia | null>(null);
  // Your own uploaded photo/video, kept as a tile even after picking a preset.
  const [custom, setCustom] = useState<WallpaperMedia | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => uploadAbortRef.current?.abort(), []);
  const selectedMediaUrl = selected?.mediaUrl ?? null;

  // Seed local draft state from the real applied wallpaper once it loads —
  // done during render (React's documented pattern for "adjust state when
  // a prop/query result changes"), not inside an effect body, so it lands
  // before paint and only fires once rather than stomping on in-progress
  // slider drags every time this query happens to refetch.
  const [seeded, setSeeded] = useState(false);
  if (!seeded && wallpaperQuery.isSuccess) {
    setSeeded(true);
    if (applied) {
      setSettings({ blur: applied.blur, dim: applied.dim, brightness: applied.brightness, fitMode: applied.fitMode });
      const media: WallpaperMedia = {
        type: applied.type,
        mediaUrl: applied.mediaUrl,
        thumbnailUrl: applied.thumbnailUrl,
        mediaId: applied.mediaId ?? null,
      };
      setSelected(media);
      if (!isPresetUrl(applied.mediaUrl)) setCustom(media);
    }
  }

  // A chat's own effective-wallpaper cache (ConversationView) is keyed by
  // channelId, not by this global setting — invalidate every one of those
  // queries on any change here so re-opening a chat doesn't show a stale
  // wallpaper for up to `staleTime` (30s) after it's actually changed.
  const invalidateEffective = () => queryClient.invalidateQueries({ queryKey: ["wallpaper", "effective"] });

  const applyMutation = useMutation({
    mutationFn: ({ media, next }: { media: WallpaperMedia; next: WallpaperSettings }) =>
      chatId ? applyChatWallpaper(chatId, media, next).then((r) => r.wallpaper) : applyGlobalWallpaper(media, next),
    onSuccess: (wp) => {
      queryClient.setQueryData<Wallpaper>(wallpaperQueryKey, wp);
      invalidateEffective();
    },
  });

  const settingsMutation = useMutation({
    mutationFn: ({ wallpaperId, next }: { wallpaperId: string; next: WallpaperSettings }) =>
      chatId ? updateChatWallpaperSettings(wallpaperId, chatId, next) : updateGlobalWallpaperSettings(wallpaperId, next),
    onSuccess: (wp) => {
      queryClient.setQueryData<Wallpaper>(wallpaperQueryKey, wp);
      invalidateEffective();
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => (chatId ? resetChatWallpaper(chatId) : resetGlobalWallpaper()),
    onSuccess: () => {
      queryClient.setQueryData<Wallpaper | null>(wallpaperQueryKey, null);
      setSelected(null);
      setSettings(DEFAULT_SETTINGS);
      invalidateEffective();
    },
  });

  function selectMedia(media: WallpaperMedia) {
    // Picking what's already applied is a no-op.
    if (applied && applied.mediaUrl === media.mediaUrl && selectedMediaUrl === media.mediaUrl) return;
    // A pending slider save would otherwise land after (and on top of)
    // this new wallpaper — drop it; `settings` already carries its values.
    pendingSave.cancel();
    setSelected(media);
    applyMutation.mutate({ media, next: settings });
  }

  const [editingWallpaper, setEditingWallpaper] = useState<File | null>(null);
  async function handleFile(file: File) {
    setUploadError(null);
    const checked = classifyFile(file);
    if ("error" in checked) {
      setUploadError(checked.error);
      return;
    }
    const { kind } = checked;
    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUpload({ kind, phase: "uploading", percent: 0 });
    const onProgress = (loaded: number, total: number) => {
      const percent = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      setUpload({ kind, phase: percent >= 100 ? "processing" : "uploading", percent });
    };
    try {
      let media: WallpaperMedia;
      if (kind === "video") {
        const res = await uploadWallpaperVideo(file, onProgress, controller.signal);
        media = { type: "video", mediaUrl: res.url, thumbnailUrl: res.thumbnailUrl, mediaId: res.mediaId };
      } else {
        const res = await uploadWallpaperImage(file, onProgress, controller.signal);
        media = { type: "image", mediaUrl: res.url, thumbnailUrl: res.url, mediaId: res.mediaId };
      }
      if (controller.signal.aborted) return;
      setCustom(media);
      selectMedia(media);
    } catch (err) {
      if (controller.signal.aborted) return;
      setUploadError(
        err instanceof ApiError && err.message
          ? err.message
          : `Couldn't upload the ${kind === "video" ? "video" : "photo"}. Check your connection and try again.`,
      );
    } finally {
      if (uploadAbortRef.current === controller) {
        uploadAbortRef.current = null;
        setUpload(null);
      }
    }
  }

  function cancelUpload() {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    setUpload(null);
  }

  // Slider/fit-mode changes: re-apply if there's no wallpaper doc to patch
  // yet (picking a preset always creates one first, so this mostly matters
  // if this ever renders before that request resolves), otherwise patch the
  // existing doc's settings without resending mediaUrl.
  //
  // Debounced: a range input fires onChange for every step of a drag, and
  // each one used to be its own PATCH — dozens per drag, whose responses
  // could land out of order and leave the cache (and the chat's wallpaper)
  // on an intermediate value. The preview still updates live from state.
  const pendingSave = useTrailingDebounce(350);
  function commitSettings(next: WallpaperSettings) {
    setSettings(next);
    if (!selected) return;
    const media = selected;
    const wallpaperId = applied?.id;
    const send = () => {
      if (wallpaperId) settingsMutation.mutate({ wallpaperId, next });
      else applyMutation.mutate({ media, next });
    };
    pendingSave.schedule(send);
  }

  // Every tile in the grid: your own upload first (if any), then the presets.
  const tiles: { key: string; label: string; media: WallpaperMedia; thumb: string | null }[] = [
    ...(custom
      ? [
          {
            key: "custom",
            label: custom.type === "video" ? "Your video" : "Your photo",
            media: custom,
            thumb: custom.thumbnailUrl ?? (custom.type === "image" ? custom.mediaUrl : null),
          },
        ]
      : []),
    ...PRESETS.map((p) => ({ key: p.id, label: p.label, media: { type: "image" as const, mediaUrl: presetUrl(p.id) }, thumb: presetUrl(p.id) })),
  ];

  // Radio-group keyboard model for the tile grid: arrows move (and pick,
  // like any radio group), only the selected tile is a Tab stop.
  function onTileKeyDown(e: React.KeyboardEvent, index: number) {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl" && (e.key === "ArrowRight" || e.key === "ArrowLeft");
    const next = (index + (rtl ? -delta : delta) + tiles.length) % tiles.length;
    selectMedia(tiles[next].media);
    tileRefs.current[next]?.focus();
  }

  const saving = applyMutation.isPending || settingsMutation.isPending || resetMutation.isPending;
  const failed = applyMutation.error ?? settingsMutation.error ?? resetMutation.error;
  const selectedIndex = tiles.findIndex((t) => selectedMediaUrl === t.media.mediaUrl);
  const isVideo = selected?.type === "video";
  const title = chatId && channel ? `${channelDisplayName(channel)} wallpaper` : "Wallpaper";
  const scopeText = selectedMediaUrl
    ? chatId
      ? "Applies to this chat only — everyone else in it can see and accept it too"
      : "Applies to every chat that hasn't set its own wallpaper"
    : "No wallpaper set — using the default background";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <PageHeader
        title={title}
        subtitle={chatId ? "Just for this chat" : "Default for all chats"}
        backHref={chatId ? `/app/c/${chatId}/info` : "/app/settings/appearance"}
        backOnDesktop
      />

      <PageBody>
        {wallpaperQuery.isPending ? (
          <div role="status" aria-label="Loading wallpaper" className="flex flex-col gap-7">
            <Skeleton className="h-60 w-full rounded-[var(--radius-md)]" />
            <div className="grid grid-cols-3 gap-3">
              {PRESETS.map((p) => (
                <Skeleton key={p.id} className="h-24 rounded-[var(--radius-md)]" />
              ))}
            </div>
          </div>
        ) : wallpaperQuery.isError ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-[14px] text-danger">Couldn&apos;t load your wallpaper.</p>
            <Button size="sm" variant="secondary" onClick={() => wallpaperQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <section aria-label="Preview" className="flex flex-col gap-2">
              <div className="relative isolate h-60 overflow-hidden rounded-[var(--radius-md)] border border-line bg-canvas" aria-hidden>
                {selected ? (
                  // Same layer the chat uses, so the preview matches it exactly —
                  // a video plays muted and looped (or shows its still in Lite mode).
                  <ChatWallpaper
                    wallpaper={{ ...settings, type: selected.type, mediaUrl: selected.mediaUrl, thumbnailUrl: selected.thumbnailUrl ?? null }}
                    className="-z-10"
                  />
                ) : null}
                {upload ? (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/55 px-6 text-center text-white">
                    <Spinner className="size-7 text-white" label={uploadLabel(upload)} />
                    <span className="text-[14px] font-semibold">{uploadLabel(upload)}</span>
                    {upload.phase === "uploading" ? (
                      <span className="block h-1.5 w-40 overflow-hidden rounded-full bg-white/25">
                        <span className="block h-full rounded-full bg-white" style={{ width: `${upload.percent}%` }} />
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="flex h-full flex-col justify-end gap-2 p-4">
                  <div className="max-w-[75%] self-start rounded-[var(--radius-bubble)] rounded-es-[6px] bg-other px-3.5 py-2 text-[14px] text-fg shadow-sm">
                    Dinner at grandma&apos;s on Sunday?
                    <span className="tabular ms-2 text-[11.5px] text-muted">18:02</span>
                  </div>
                  <div className="max-w-[75%] self-end rounded-[var(--radius-bubble)] rounded-ee-[6px] bg-own px-3.5 py-2 text-[14px] text-own-fg shadow-sm">
                    Yes! I&apos;ll bring dessert
                    <span className="tabular ms-2 text-[11.5px] text-own-meta">18:04</span>
                  </div>
                </div>
              </div>
              <p className="flex items-center justify-between gap-3 px-1 text-[13px] text-muted">
                <span>{scopeText}</span>
                <span role="status" className="tabular shrink-0">
                  {upload ? uploadLabel(upload) : saving ? "Saving…" : null}
                </span>
              </p>
              {failed ? (
                <p role="alert" className="px-1 text-[13px] text-danger">
                  {failed instanceof ApiError ? failed.message : "Couldn't save your wallpaper. Check your connection and try again."}
                </p>
              ) : null}
            </section>

            <section aria-labelledby="wallpaper-presets" className="flex flex-col gap-2">
              <h2 id="wallpaper-presets" className="px-1 text-[13.5px] font-semibold text-muted">
                Choose a look
              </h2>
              <div role="radiogroup" aria-labelledby="wallpaper-presets" className="grid grid-cols-3 gap-3">
                {tiles.map((t, i) => {
                  const isSelected = selectedMediaUrl === t.media.mediaUrl;
                  const tabbable = isSelected || (selectedIndex === -1 && i === 0);
                  return (
                    <button
                      key={t.key}
                      ref={(el) => {
                        tileRefs.current[i] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      tabIndex={tabbable ? 0 : -1}
                      onClick={() => selectMedia(t.media)}
                      onKeyDown={(e) => onTileKeyDown(e, i)}
                      className="pressable group flex flex-col gap-1.5 rounded-[var(--radius-md)] text-start"
                    >
                      <span
                        className={cn(
                          "relative block h-24 w-full overflow-hidden rounded-[var(--radius-md)] border bg-sunken bg-cover bg-center transition-shadow duration-[var(--dur-fast)]",
                          isSelected
                            ? "border-transparent ring-2 ring-accent ring-offset-2 ring-offset-canvas"
                            : "border-line group-hover:border-line-strong",
                        )}
                        style={t.thumb ? { backgroundImage: `url(${t.thumb})` } : undefined}
                      >
                        {t.media.type === "video" ? (
                          <span className="absolute bottom-2 start-2 flex size-6 items-center justify-center rounded-full bg-black/55 text-white">
                            <Film className="size-3.5" strokeWidth={2.2} aria-hidden />
                          </span>
                        ) : null}
                        {isSelected ? (
                          <span className="absolute end-2 top-2 flex size-6 items-center justify-center rounded-full bg-accent text-accent-fg shadow-sm">
                            <Check className="size-3.5" strokeWidth={3} aria-hidden />
                          </span>
                        ) : null}
                      </span>
                      <span className={cn("px-0.5 text-[13.5px] font-semibold", isSelected ? "text-fg" : "text-fg-2")}>{t.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-md)] border border-line bg-panel p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={!!upload} aria-describedby="wallpaper-upload-hint">
                    <Upload className="size-[18px]" strokeWidth={1.8} aria-hidden />
                    Choose from device
                  </Button>
                  {upload ? (
                    <Button variant="ghost" onClick={cancelUpload}>
                      Cancel upload
                    </Button>
                  ) : null}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Reset so picking the same file again still fires a change.
                    e.target.value = "";
                    // Photos get the editor first (crop, adjust…); videos upload as they are.
                    if (file) {
                      if (file.type.startsWith("image/") && file.type !== "image/gif") setEditingWallpaper(file);
                      else void handleFile(file);
                    }
                  }}
                />
                {editingWallpaper ? (
                  <MediaEditor
                    files={[editingWallpaper]}
                    variant="single"
                    allowVideo={false}
                    imageTier="hd"
                    confirmLabel="Use photo"
                    onClose={() => setEditingWallpaper(null)}
                    onDone={(r) => {
                      setEditingWallpaper(null);
                      if (r.items[0]) void handleFile(r.items[0].file);
                    }}
                  />
                ) : null}
                <p id="wallpaper-upload-hint" className="text-[13px] leading-snug text-muted">
                  A photo (up to 15 MB) or a video (up to 60 MB). Videos play silently and loop. They&apos;re paused in Lite mode and when Reduce
                  motion is on. Only the first 10 seconds are used.
                </p>
                {uploadError ? (
                  <p role="alert" className="text-[13px] text-danger">
                    {uploadError}
                  </p>
                ) : null}
              </div>
            </section>

            <section aria-labelledby="wallpaper-adjust" className="flex flex-col gap-2">
              <h2 id="wallpaper-adjust" className="px-1 text-[13.5px] font-semibold text-muted">
                Adjust
              </h2>
              <div className="flex flex-col gap-5 rounded-[var(--radius-md)] border border-line bg-panel p-4">
                <div className="flex flex-col gap-1.5">
                  <SliderRow label="Blur" value={settings.blur} min={0} max={20} unit="px" onChange={(v) => commitSettings({ ...settings, blur: v })} />
                  {isVideo ? (
                    <p className="text-[13px] leading-snug text-muted">
                      Blur isn&apos;t applied to video wallpapers while they play. It&apos;s used for the still frame shown in Lite mode.
                    </p>
                  ) : null}
                </div>
                <SliderRow label="Dim" value={settings.dim} min={0} max={100} unit="%" onChange={(v) => commitSettings({ ...settings, dim: v })} />
                <SliderRow
                  label="Brightness"
                  value={settings.brightness}
                  min={50}
                  max={150}
                  unit="%"
                  onChange={(v) => commitSettings({ ...settings, brightness: v })}
                />
                <div className="flex flex-col gap-2">
                  <span aria-hidden className="text-[14px] font-semibold text-fg-2">
                    Fit
                  </span>
                  <SegmentedTabs
                    aria-label="Fit"
                    options={FIT_OPTIONS}
                    value={settings.fitMode}
                    onChange={(fitMode) => commitSettings({ ...settings, fitMode })}
                  />
                </div>
              </div>
            </section>

            {selectedMediaUrl ? (
              <Button
                variant="danger-soft"
                block
                onClick={() => {
                  pendingSave.cancel();
                  resetMutation.mutate();
                }}
                loading={resetMutation.isPending}
                disabled={saving}
              >
                <ImageOff className="size-[18px]" strokeWidth={1.8} aria-hidden />
                Remove wallpaper
              </Button>
            ) : null}
          </>
        )}
      </PageBody>
    </div>
  );
}

export default function WallpaperSettingsPage() {
  return (
    <Suspense fallback={null}>
      <WallpaperSettingsPageInner />
    </Suspense>
  );
}
