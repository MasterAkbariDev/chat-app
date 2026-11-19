import type { QueryClient } from "@tanstack/react-query";
import { senderId, senderName, type AttachmentMeta, type ChatMessage } from "@/lib/api/types";
import { fileNameOf } from "@/lib/files";
import { resolveAttachmentUrl } from "@/lib/media-src";
import { messagesKey } from "@/lib/messages-query";
import type { AdjacentResolver, PlaybackTrack } from "@/lib/playback";

/** Title / artist line for a music message: its tags, else the file name without extension. */
export function musicLabels(meta: AttachmentMeta | null | undefined, originalFilename: string | null | undefined, url?: string): { title: string; artist: string | null } {
  const title = meta?.title?.trim();
  const artist = meta?.artist?.trim() || null;
  if (title) return { title, artist };
  const name = fileNameOf(originalFilename, url).replace(/\.[A-Za-z0-9]{1,8}$/, "");
  return { title: name || "Unknown track", artist };
}

/** Player track id of a message's `index`th track: the message id, then `<id>#<i>`. */
export function musicTrackId(messageId: string, index: number): string {
  return index > 0 ? `${messageId}#${index}` : messageId;
}

/** A chat message → the app-wide player's tracks (several for a music group), [] when it
 *  isn't playable music. */
export function musicTracksFrom(m: ChatMessage, currentUserId: string | undefined): PlaybackTrack[] {
  if (m.type !== "audio" || m._id.startsWith("temp-")) return [];
  const sender = currentUserId && senderId(m.senderId) === currentUserId ? "You" : senderName(m.senderId);
  return (m.attachments ?? []).flatMap((url, i) => {
    if (!url || url.startsWith("pending:")) return [];
    const meta = m.attachmentMeta?.[url];
    const { title, artist } = musicLabels(meta, meta?.fileName ?? (i === 0 ? m.originalFilename : null), url);
    return [
      {
        id: musicTrackId(m._id, i),
        kind: "music" as const,
        src: resolveAttachmentUrl(url),
        durationSec: meta?.durationSec ?? (i === 0 ? m.durationSec : null),
        senderName: sender,
        createdAt: m.createdAt,
        channelId: m.channelId,
        title,
        artist,
        coverUrl: meta?.thumbUrl ? resolveAttachmentUrl(meta.thumbUrl) : null,
      },
    ];
  });
}

/** The first track of a music message (kept for callers that want one). */
export function musicTrackFrom(m: ChatMessage, currentUserId: string | undefined): PlaybackTrack | null {
  return musicTracksFrom(m, currentUserId)[0] ?? null;
}

/** Previous/next music in a chat, read from the loaded messages (so it keeps working after you
 *  leave the chat, as long as its messages are cached). Tracks of a group play in order. */
export function chatMusicResolver(queryClient: QueryClient, channelId: string, currentUserId: string | undefined): AdjacentResolver {
  return (id, dir) => {
    const list = queryClient.getQueryData<ChatMessage[]>(messagesKey(channelId)) ?? [];
    const tracks = list.filter((m) => !(currentUserId && m.deletedFor?.includes(currentUserId))).flatMap((m) => musicTracksFrom(m, currentUserId));
    const i = tracks.findIndex((t) => t.id === id);
    if (i < 0) return null;
    return tracks[i + dir] ?? null;
  };
}
