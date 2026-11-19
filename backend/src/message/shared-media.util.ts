import type { PipelineStage, Types } from "mongoose";
import { MessageType } from "src/enum/base.enum";

/** The tabs of a chat's shared-media browser (Telegram's order). */
export const SHARED_MEDIA_KINDS = [
  "media",
  "files",
  "music",
  "voice",
  "links",
  "gifs",
] as const;
export type SharedMediaKind = (typeof SHARED_MEDIA_KINDS)[number];

export function isSharedMediaKind(v: unknown): v is SharedMediaKind {
  return (
    typeof v === "string" &&
    (SHARED_MEDIA_KINDS as readonly string[]).includes(v)
  );
}

/** A file whose name (or URL) ends in an audio extension counts as music. */
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|wma|alac|aiff?)$/i;
const AUDIO_MIME = /^audio\//i;
const LINK = /(https?:\/\/|www\.)\S/i;

const isAudioFile = {
  $or: [
    { originalFilename: { $regex: AUDIO_EXT } },
    { attachments: { $elemMatch: { $regex: AUDIO_EXT } } },
  ],
};

/**
 * Message-level filter for one tab (`GET …/shared`, the older message list). Kept free of
 * `channelId` etc. so the caller merges it into its own visibility filter. The item list and
 * counts below classify each attachment instead.
 */
export function sharedKindFilter(
  kind: SharedMediaKind,
): Record<string, unknown> {
  switch (kind) {
    case "media":
      return { type: { $in: [MessageType.IMAGE, MessageType.VIDEO] } };
    case "files":
      return { type: MessageType.FILE, $nor: [isAudioFile] };
    case "music":
      return {
        $or: [
          { type: MessageType.AUDIO },
          { type: MessageType.FILE, ...isAudioFile },
        ],
      };
    case "links":
      return { type: MessageType.TEXT, content: { $regex: LINK } };
    case "voice":
      return { type: { $in: [MessageType.VOICE, MessageType.VIDEO_NOTE] } };
    case "gifs":
      return { type: MessageType.GIF };
  }
}

/** Message types that can hold items of each tab (the item pipeline's first, indexed match). */
const TYPES_FOR: Record<SharedMediaKind, MessageType[]> = {
  media: [MessageType.IMAGE, MessageType.VIDEO],
  files: [MessageType.FILE],
  music: [MessageType.AUDIO, MessageType.FILE],
  voice: [MessageType.VOICE, MessageType.VIDEO_NOTE],
  links: [MessageType.TEXT],
  gifs: [MessageType.GIF],
};

export function sharedMessageTypes(kinds: readonly SharedMediaKind[]) {
  return [...new Set(kinds.flatMap(k => TYPES_FOR[k]))];
}

const str = (path: string) => ({ $ifNull: [path, ""] });
const matches = (path: string, regex: RegExp) => ({
  $regexMatch: { input: str(path), regex },
});

/**
 * Stages that turn each message into one row per shared item — an album's photos and
 * videos, each file of a file group, each track of a music group — tagged with the tab it
 * belongs to (`kind`, null when none) and its attachment `idx`. A link message is one item
 * (idx 0). Order is kept: newest message first, then its attachments in order.
 *
 * A file counts as music when its stored asset is audio (`attachmentMeta.kind`), its MIME
 * type or name says so, or its URL ends in an audio extension (legacy uploads).
 */
export function explodeSharedItemsStages(): PipelineStage[] {
  return [
    {
      $project: {
        type: 1,
        createdAt: 1,
        content: 1,
        originalFilename: 1,
        // Text (links) has no attachments: still one row.
        att: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ["$attachments", []] } }, 0] },
            "$attachments",
            [null],
          ],
        },
        metaArr: { $objectToArray: { $ifNull: ["$attachmentMeta", {}] } },
      },
    },
    { $unwind: { path: "$att", includeArrayIndex: "idx" } },
    {
      $addFields: {
        m: {
          $arrayElemAt: [
            {
              $map: {
                input: {
                  $filter: {
                    input: "$metaArr",
                    cond: { $eq: ["$$this.k", "$att"] },
                  },
                },
                in: "$$this.v",
              },
            },
            0,
          ],
        },
      },
    },
    {
      $addFields: {
        hasAtt: {
          $and: [{ $ne: ["$att", null] }, { $ne: ["$att", ""] }],
        },
        isAudio: {
          $or: [
            { $eq: ["$m.kind", "audio"] },
            matches("$m.mimeType", AUDIO_MIME),
            matches("$m.fileName", AUDIO_EXT),
            matches("$att", AUDIO_EXT),
            {
              $and: [
                { $eq: ["$idx", 0] },
                matches("$originalFilename", AUDIO_EXT),
              ],
            },
          ],
        },
      },
    },
    {
      $addFields: {
        kind: {
          $switch: {
            branches: [
              {
                case: {
                  $and: [
                    "$hasAtt",
                    { $in: ["$type", [MessageType.IMAGE, MessageType.VIDEO]] },
                  ],
                },
                then: "media",
              },
              {
                case: {
                  $and: ["$hasAtt", { $eq: ["$type", MessageType.GIF] }],
                },
                then: "gifs",
              },
              {
                case: {
                  $and: [
                    "$hasAtt",
                    { $eq: ["$idx", 0] },
                    {
                      $in: [
                        "$type",
                        [MessageType.VOICE, MessageType.VIDEO_NOTE],
                      ],
                    },
                  ],
                },
                then: "voice",
              },
              {
                case: {
                  $and: ["$hasAtt", { $eq: ["$type", MessageType.AUDIO] }],
                },
                then: "music",
              },
              {
                case: {
                  $and: ["$hasAtt", { $eq: ["$type", MessageType.FILE] }],
                },
                then: { $cond: ["$isAudio", "music", "files"] },
              },
              {
                case: {
                  $and: [
                    { $eq: ["$type", MessageType.TEXT] },
                    { $eq: ["$idx", 0] },
                    matches("$content", LINK),
                  ],
                },
                then: "links",
              },
            ],
            default: null,
          },
        },
      },
    },
  ];
}

/** Paging position: the last item a page returned. */
export interface SharedCursor {
  createdAt: Date;
  messageId: Types.ObjectId;
  index: number;
}

export function encodeSharedCursor(c: {
  createdAt: Date;
  messageId: string;
  index: number;
}): string {
  return `${c.createdAt.toISOString()}_${c.messageId}_${c.index}`;
}

/** Parses `encodeSharedCursor`'s output (or a bare ISO date, as the older endpoint took);
 *  null when it isn't one. */
export function decodeSharedCursor(
  raw: string | undefined,
  toObjectId: (id: string) => Types.ObjectId | null,
): SharedCursor | { createdAt: Date } | null {
  if (!raw) return null;
  const parts = raw.split("_");
  const createdAt = new Date(parts[0]);
  if (isNaN(createdAt.getTime())) return null;
  if (parts.length !== 3) return { createdAt };
  const messageId = toObjectId(parts[1]);
  const index = Number(parts[2]);
  if (!messageId || !Number.isInteger(index) || index < 0) return null;
  return { createdAt, messageId, index };
}

/** After `explodeSharedItemsStages`: only the items strictly after the cursor. */
export function afterCursorMatch(
  c: SharedCursor | { createdAt: Date },
): Record<string, unknown> {
  if (!("messageId" in c)) return { createdAt: { $lt: c.createdAt } };
  return {
    $or: [
      { createdAt: { $lt: c.createdAt } },
      { createdAt: c.createdAt, _id: { $lt: c.messageId } },
      { createdAt: c.createdAt, _id: c.messageId, idx: { $gt: c.index } },
    ],
  };
}
