/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- raw, untyped documents from the old app's database */
/**
 * Second step of moving the old app's data over, run after `migrate-legacy-data.ts` has copied
 * the collections into this project's database (DATABASE_URL). It reshapes what the copy left in
 * the old format so the new app can use it. Safe to re-run: every step only fills in or rewrites
 * to the same result.
 *
 *   npm run migrate:normalize -- --dry-run   # report only
 *   npm run migrate:normalize                # (in the production image: node dist/scripts/normalize-legacy-data.js)
 *
 * 1. Media links: the old app stored absolute links to whatever host served it at the time
 *    (`https://<old ip or domain>[/api/chat]/uploads/...`). They become relative `/uploads/...`
 *    paths, which the web app resolves against its own API address, so they survive host changes.
 *    Applies to message content/attachments, profile photos, chat photos and wallpapers.
 * 2. Media messages: the old app kept a photo/file/voice/video/GIF link in `content` with empty
 *    `attachments`; the new app reads `attachments`.
 * 3. Profile photos: old `avatarUrl[]` → `image[]` + the `photos` list. Chats: old `imageUrl` →
 *    `image[]`; Saved Messages (a "private" chat linked `saved-<userId>`) → type `saved_messages`;
 *    direct chats missing the other person's row get one in the "removed for me" state.
 * 4. Reactions: the old `{ emoji: [userId] }` map on each message → `message_reactions` rows.
 * 5. Chat list: `chat_state` (last message time/preview, member count) for every chat.
 * 6. Read positions: each member's `lastReadAt`/`lastReadMessageId`, from the old per-message
 *    `readBy` lists (and their own messages), where not already set.
 */
import "dotenv/config";
import {
  MongoClient,
  ObjectId,
  AnyBulkWriteOperation,
  Document,
} from "mongodb";
import { buildMessagePreview } from "../src/message/message-preview.util";

const DRY_RUN = process.argv.includes("--dry-run");
const URI = process.env.DATABASE_URL;
if (!URI) throw new Error("DATABASE_URL is not set (the new app's database).");

const MEDIA_TYPES = new Set([
  "image",
  "file",
  "video",
  "voice",
  "gif",
  "sticker",
  "video_note",
]);

/** `https://host[/api/chat]/uploads/x` → `/uploads/x`; anything else is returned unchanged. */
export function relativeUpload(url: unknown): unknown {
  if (typeof url !== "string") return url;
  const m = url.match(/^https?:\/\/[^/]+(?:\/api\/chat)?(\/uploads\/.*)$/);
  return m ? m[1] : url;
}

const ids = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String)
    : v && typeof v === "object"
      ? Object.keys(v)
      : [];

async function flush(
  db: ReturnType<MongoClient["db"]>,
  name: string,
  ops: AnyBulkWriteOperation<Document>[],
) {
  if (DRY_RUN || ops.length === 0) return;
  for (let i = 0; i < ops.length; i += 1000) {
    await db
      .collection(name)
      .bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  }
}

async function main() {
  const client = new MongoClient(URI!);
  await client.connect();
  const db = client.db();
  const report: Record<string, number> = {};
  const count = (k: string, n = 1) => (report[k] = (report[k] ?? 0) + n);

  // --- 1–2: messages ------------------------------------------------------------------------
  const msgOps: AnyBulkWriteOperation<Document>[] = [];
  const reactionOps: AnyBulkWriteOperation<Document>[] = [];
  // channelId → userId → latest read { at, id }
  const reads = new Map<string, Map<string, { at: Date; id: string }>>();
  const noteRead = (
    channelId: string,
    userId: string,
    at: Date,
    id: string,
  ) => {
    let byUser = reads.get(channelId);
    if (!byUser) reads.set(channelId, (byUser = new Map()));
    const cur = byUser.get(userId);
    if (!cur || cur.at < at) byUser.set(userId, { at, id });
  };

  const cursor = db.collection("messages").find(
    {},
    {
      projection: {
        channelId: 1,
        senderId: 1,
        type: 1,
        content: 1,
        attachments: 1,
        reactions: 1,
        readBy: 1,
        createdAt: 1,
        forwardFrom: 1,
      },
    },
  );
  for await (const m of cursor) {
    const set: Document = {};
    const attachments: unknown[] = Array.isArray(m.attachments)
      ? m.attachments
      : [];
    const fixedAtt = attachments.map(relativeUpload);
    let content = m.content;
    if (
      MEDIA_TYPES.has(m.type) &&
      fixedAtt.length === 0 &&
      typeof content === "string" &&
      /\/uploads\//.test(content)
    ) {
      fixedAtt.push(relativeUpload(content.trim()));
      content = "";
      count("messages: media link moved to attachments");
    }
    if (JSON.stringify(fixedAtt) !== JSON.stringify(attachments))
      set.attachments = fixedAtt;
    if (content !== m.content) set.content = content;
    else if (MEDIA_TYPES.has(m.type) && relativeUpload(content) !== content)
      set.content = relativeUpload(content);
    if (
      m.forwardFrom?.avatarUrl &&
      relativeUpload(m.forwardFrom.avatarUrl) !== m.forwardFrom.avatarUrl
    ) {
      set["forwardFrom.avatarUrl"] = relativeUpload(m.forwardFrom.avatarUrl);
    }
    if (Object.keys(set).length) {
      msgOps.push({
        updateOne: { filter: { _id: m._id }, update: { $set: set } },
      });
      count("messages: links rewritten");
    }

    // 4: reactions
    if (
      m.reactions &&
      typeof m.reactions === "object" &&
      !Array.isArray(m.reactions)
    ) {
      for (const [emoji, users] of Object.entries(
        m.reactions as Record<string, unknown>,
      )) {
        for (const userId of ids(users)) {
          const key = {
            messageId: String(m._id),
            userId,
            emoji,
            packItemId: null,
          };
          reactionOps.push({
            updateOne: {
              filter: key,
              update: {
                $setOnInsert: {
                  ...key,
                  channelId: String(m.channelId),
                  packItemRelativePath: null,
                  packId: null,
                  createdAt: m.createdAt ?? new Date(),
                  updatedAt: m.createdAt ?? new Date(),
                },
              },
              upsert: true,
            },
          });
          count("reactions");
        }
      }
    }

    // 6: read positions (readers, plus the sender, have read up to this message)
    const at: Date = m.createdAt ?? new Date(0);
    for (const userId of ids(m.readBy))
      noteRead(String(m.channelId), userId, at, String(m._id));
    if (m.senderId)
      noteRead(String(m.channelId), String(m.senderId), at, String(m._id));
  }
  await flush(db, "messages", msgOps);
  await flush(db, "message_reactions", reactionOps);

  // --- 3: users -----------------------------------------------------------------------------
  const userOps: AnyBulkWriteOperation<Document>[] = [];
  for await (const u of db
    .collection("user")
    .find({}, { projection: { avatarUrl: 1, image: 1, photos: 1 } })) {
    const legacy = (Array.isArray(u.avatarUrl) ? u.avatarUrl : [])
      .map(relativeUpload)
      .filter(Boolean) as string[];
    const image = (Array.isArray(u.image) ? u.image : []).map(
      relativeUpload,
    ) as string[];
    const set: Document = {};
    if (image.length === 0 && legacy.length) set.image = [legacy[0]];
    else if (JSON.stringify(image) !== JSON.stringify(u.image ?? []))
      set.image = image;
    if ((!Array.isArray(u.photos) || u.photos.length === 0) && legacy.length) {
      set.photos = legacy.map(url => ({
        _id: new ObjectId(),
        url,
        kind: "image",
        posterUrl: null,
        createdAt: new Date(),
      }));
    }
    if (Object.keys(set).length) {
      userOps.push({
        updateOne: { filter: { _id: u._id }, update: { $set: set } },
      });
      count("users: profile photos");
    }
  }
  await flush(db, "user", userOps);

  // --- chats: photos, Saved Messages, direct-chat memberships ---------------------------------
  const chatOps: AnyBulkWriteOperation<Document>[] = [];
  const dmMemberOps: AnyBulkWriteOperation<Document>[] = [];
  for await (const c of db
    .collection("chats")
    .find({}, { projection: { image: 1, imageUrl: 1, type: 1, link: 1 } })) {
    const set: Document = {};
    // The old app kept group/channel photos in `imageUrl` (a string or a list).
    const legacyImage = (
      Array.isArray(c.imageUrl) ? c.imageUrl : c.imageUrl ? [c.imageUrl] : []
    ).filter(Boolean);
    const current = Array.isArray(c.image) ? c.image : [];
    const image = (current.length ? current : legacyImage).map(relativeUpload);
    if (JSON.stringify(image) !== JSON.stringify(current)) set.image = image;
    // Saved Messages was a "private" chat with a `saved-<userId>` link.
    if (
      c.type === "private" &&
      typeof c.link === "string" &&
      c.link.startsWith("saved-")
    ) {
      set.type = "saved_messages";
    }
    if (Object.keys(set).length) {
      chatOps.push({
        updateOne: { filter: { _id: c._id }, update: { $set: set } },
      });
      count(set.type ? "chats: Saved Messages" : "chats: photos");
    }
    // A direct chat whose other person had removed it has no row for them, so the chat had no
    // name or photo. Give them a row in the new app's "removed for me" state (not joined, hidden).
    const dm =
      c.type === "private" && typeof c.link === "string"
        ? c.link.match(/^private-([a-f0-9]{24})-([a-f0-9]{24})$/)
        : null;
    if (dm) {
      const channelId = String(c._id);
      const now = new Date();
      for (const userId of [dm[1], dm[2]]) {
        dmMemberOps.push({
          updateOne: {
            filter: { channelId, userId },
            update: {
              $setOnInsert: {
                channelId,
                userId,
                role: "member",
                isJoined: false,
                hiddenAt: now,
                isBanned: false,
                isMuted: false,
                isPinned: false,
                mutedByAdmin: false,
                lastReadMessageId: null,
                lastReadAt: null,
                createdAt: now,
                updatedAt: now,
              },
            },
            upsert: true,
          },
        });
      }
    }
  }
  await flush(db, "chats", chatOps);
  const membersBefore = await db.collection("chatmembers").countDocuments();
  await flush(db, "chatmembers", dmMemberOps);
  count(
    "direct chats: missing member rows added",
    (await db.collection("chatmembers").countDocuments()) - membersBefore,
  );
  const wpOps: AnyBulkWriteOperation<Document>[] = [];
  for await (const w of db
    .collection("wallpapers")
    .find({}, { projection: { mediaUrl: 1, thumbnailUrl: 1 } })) {
    const set: Document = {};
    if (relativeUpload(w.mediaUrl) !== w.mediaUrl)
      set.mediaUrl = relativeUpload(w.mediaUrl);
    if (relativeUpload(w.thumbnailUrl) !== w.thumbnailUrl)
      set.thumbnailUrl = relativeUpload(w.thumbnailUrl);
    if (Object.keys(set).length) {
      wpOps.push({
        updateOne: { filter: { _id: w._id }, update: { $set: set } },
      });
      count("wallpapers: links");
    }
  }
  await flush(db, "wallpapers", wpOps);

  // --- 5: chat_state ------------------------------------------------------------------------
  const stateOps: AnyBulkWriteOperation<Document>[] = [];
  for await (const c of db
    .collection("chats")
    .find({}, { projection: { _id: 1 } })) {
    const channelId = String(c._id);
    const last = await db
      .collection("messages")
      .find({ channelId, isDeleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(1)
      .project({ content: 1, type: 1, createdAt: 1, metadata: 1 })
      .next();
    const memberCount = await db.collection("chatmembers").countDocuments({
      channelId,
      isJoined: { $ne: false },
      isBanned: { $ne: true },
    });
    stateOps.push({
      updateOne: {
        filter: { channelId },
        update: {
          $set: {
            lastMessageAt: last?.createdAt ?? null,
            lastMessagePreview: last
              ? buildMessagePreview(last as never)
              : null,
            memberCount,
            updatedAt: new Date(),
          },
          $setOnInsert: { channelId, createdAt: new Date() },
        },
        upsert: true,
      },
    });
    count("chat_state");
  }
  await flush(db, "chat_state", stateOps);

  // --- 6: read positions (only where missing) ---------------------------------------------------
  const memberOps: AnyBulkWriteOperation<Document>[] = [];
  for (const [channelId, byUser] of reads) {
    for (const [userId, r] of byUser) {
      memberOps.push({
        updateOne: {
          filter: {
            channelId,
            userId: {
              $in: [
                userId,
                ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
              ],
            },
            lastReadAt: null,
          },
          update: { $set: { lastReadAt: r.at, lastReadMessageId: r.id } },
        },
      });
    }
  }
  await flush(db, "chatmembers", memberOps);
  count("read positions considered", memberOps.length);

  // When the old data came in: the reverse script (migrate-new-to-legacy) copies back what changed after it.
  if (!DRY_RUN) {
    await db
      .collection("migration_meta")
      .updateOne(
        { _id: "legacy-import" as unknown as ObjectId },
        { $set: { importedAt: new Date() } },
        { upsert: true },
      );
  }

  console.log(DRY_RUN ? "Dry run — nothing written." : "Done.");
  console.table(Object.entries(report).map(([step, n]) => ({ step, n })));
  await client.close();
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
