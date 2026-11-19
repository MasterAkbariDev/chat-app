import type { MediaViewerItem } from "@/components/media/MediaViewer";
import { senderId, senderName, type AttachmentMeta, type ChatMessage } from "@/lib/api/types";
import type { SharedItemsPage, SharedKind } from "@/lib/api/profile";
import { attachmentIsVideo } from "@/lib/album-layout";
import { fileNameOf } from "@/lib/files";
import { resolveAttachmentUrl } from "@/lib/media-src";
import { musicLabels, musicTrackId } from "@/lib/music";
import type { PlaybackTrack } from "@/lib/playback";

/** One thing on a shared-media tab: a single photo/video of an album, one file of a file
 *  group, one track of a music group, a voice message, or a message with links. */
export interface SharedItem {
  /** `${messageId}:${index}` — the same key the media viewer uses. */
  key: string;
  message: ChatMessage;
  /** Attachment index in the message (0 for a link message). */
  index: number;
  url: string | null;
  meta: AttachmentMeta | null;
  createdAt: string;
  /** Media: a video cell (else a photo). */
  isVideo: boolean;
}

/** Pages from the server → items, in order, each once (a refetch can overlap pages). */
export function explodeSharedPages(pages: readonly SharedItemsPage[]): SharedItem[] {
  const out: SharedItem[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const byId = new Map(page.messages.map((m) => [m._id, m]));
    for (const ref of page.items) {
      const message = byId.get(ref.messageId);
      const key = `${ref.messageId}:${ref.index}`;
      if (!message || seen.has(key)) continue;
      seen.add(key);
      const url = message.attachments?.[ref.index] ?? null;
      const meta = (url && message.attachmentMeta?.[url]) || null;
      out.push({
        key,
        message,
        index: ref.index,
        url,
        meta,
        createdAt: message.createdAt,
        isVideo: !!url && (message.type === "image" || message.type === "video") && attachmentIsVideo(message.type, url, meta),
      });
    }
  }
  return out;
}

/** "October 2026" — Telegram heads shared media with month sections. */
export function monthLabel(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale, { month: "long", year: "numeric" });
}

/** Items (newest first) split into month sections. */
export function groupByMonth<T extends { createdAt: string }>(items: readonly T[], locale?: string): { key: string; label: string; items: T[] }[] {
  const out: { key: string; label: string; items: T[] }[] = [];
  for (const it of items) {
    const d = new Date(it.createdAt);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const last = out[out.length - 1];
    if (last?.key === key) last.items.push(it);
    else out.push({ key, label: monthLabel(it.createdAt, locale), items: [it] });
  }
  return out;
}

/** "You" for your own items, else the sender's name. */
export function sharedSenderName(m: Pick<ChatMessage, "senderId">, currentUserId?: string): string {
  if (m.senderId == null) return "Someone";
  if (currentUserId && senderId(m.senderId) === currentUserId) return "You";
  return senderName(m.senderId);
}

/** The viewer's list for a grid tab (media or GIFs): oldest first, like the chat's viewer. */
export function sharedViewerItems(items: readonly SharedItem[], currentUserId?: string): MediaViewerItem[] {
  const out: MediaViewerItem[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it.url) continue;
    out.push({
      key: it.key,
      messageId: it.message._id,
      attachmentIndex: it.index,
      kind: it.message.type === "gif" ? "gif" : it.isVideo ? "video" : "image",
      url: it.url,
      width: it.meta?.width,
      height: it.meta?.height,
      blurhash: it.meta?.blurhash,
      senderName: sharedSenderName(it.message, currentUserId),
      createdAt: it.createdAt,
      durationSec: it.meta?.durationSec ?? it.message.durationSec,
    });
  }
  return out;
}

/** The name a file was sent with (a group's later files have theirs in the meta). */
export function sharedFileName(it: Pick<SharedItem, "meta" | "index" | "url" | "message">): string {
  return fileNameOf(it.meta?.fileName ?? (it.index === 0 ? it.message.originalFilename : null), it.url ?? undefined);
}

/** A music row → the app-wide player's track (same id as the chat bubble's, so both show
 *  as playing). Works for an audio file sent as a file too. */
export function sharedMusicTrack(it: SharedItem, currentUserId?: string): PlaybackTrack | null {
  if (!it.url) return null;
  const { title, artist } = musicLabels(it.meta, it.meta?.fileName ?? (it.index === 0 ? it.message.originalFilename : null), it.url);
  return {
    id: musicTrackId(it.message._id, it.index),
    kind: "music",
    src: resolveAttachmentUrl(it.url),
    durationSec: it.meta?.durationSec ?? (it.index === 0 ? it.message.durationSec : null),
    senderName: sharedSenderName(it.message, currentUserId),
    createdAt: it.createdAt,
    channelId: it.message.channelId,
    title,
    artist,
    coverUrl: it.meta?.thumbUrl ? resolveAttachmentUrl(it.meta.thumbUrl) : null,
  };
}

/** A voice / round-video row → the player's track. */
export function sharedVoiceTrack(it: SharedItem, currentUserId?: string): PlaybackTrack | null {
  if (!it.url) return null;
  return {
    id: it.message._id,
    kind: it.message.type === "video_note" ? "video_note" : "voice",
    src: resolveAttachmentUrl(it.url),
    durationSec: it.message.durationSec,
    senderName: sharedSenderName(it.message, currentUserId),
    createdAt: it.createdAt,
    channelId: it.message.channelId,
  };
}

const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

/** Every link in a message's text, normalised to an absolute URL, each once. */
export function linksIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[1].replace(/[),.!?;:\]}»"']+$/, "");
    const href = /^https?:/i.test(raw) ? raw : `https://${raw}`;
    if (!out.includes(href)) out.push(href);
  }
  return out;
}

/** "example.com" for a link (no `www.`); the input when it isn't a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A link without its scheme, for display ("example.com/a/b"). */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

/** Previous/next of `id` in a tab's list, read through `getItems` at call time (so it keeps
 *  working as pages load, and after you leave the page while the list is cached). "Next" is
 *  the row below — the list's own order. */
export function listResolver<T>(getItems: () => readonly SharedItem[], toTrack: (it: SharedItem) => T | null, idOf: (it: SharedItem) => string) {
  return (id: string, dir: 1 | -1): T | null => {
    const list = getItems();
    const i = list.findIndex((it) => idOf(it) === id);
    if (i < 0) return null;
    for (let j = i + dir; j >= 0 && j < list.length; j += dir) {
      const t = toTrack(list[j]);
      if (t) return t;
    }
    return null;
  };
}

/** Telegram's "Groups in common" lives with the shared-media tabs on a person's profile. */
export type SharedTab = SharedKind | "groups";

const TAB_KEY = "chat:shared-tab";

/** The tab last opened on this chat's shared media (per device). */
export function recallSharedTab(chatKey: string): SharedTab | null {
  try {
    const raw = window.localStorage.getItem(TAB_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, SharedTab>) : {};
    return typeof map[chatKey] === "string" ? map[chatKey] : null;
  } catch {
    return null;
  }
}

export function rememberSharedTab(chatKey: string, tab: SharedTab) {
  try {
    const raw = window.localStorage.getItem(TAB_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, SharedTab>) : {};
    delete map[chatKey];
    map[chatKey] = tab;
    // Keep the newest 200 chats.
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete map[k];
    window.localStorage.setItem(TAB_KEY, JSON.stringify(map));
  } catch {
    // Private mode / storage blocked: the first tab opens next time.
  }
}
