/* eslint-disable @typescript-eslint/no-unsafe-member-access -- raw, untyped documents from the databases */
/**
 * Copies what happened in this app back into the OLD app's database, for switching back to the
 * old app after running this one for a while. The reverse of migrate-legacy-data.ts +
 * normalize-legacy-data.ts.
 *
 *   DATABASE_URL=<this app's db> DATABASE_URL_LEGACY=<old app's db> \
 *     node dist/scripts/migrate-new-to-legacy.js [--dry-run] [--since=<ISO date>]
 *
 * What it copies (everything created or changed since `--since`, default: when the data was
 * imported from the old app — `migration_meta.legacy-import.importedAt`):
 *   - users: new accounts, and name/username/bio/password/photo changes to existing ones
 *     (the main photo goes back into the old `avatarUrl[]`)
 *   - chats and memberships created or changed in this app
 *   - messages: new ones, plus edits/deletes/pins of older ones. Reactions go back into the old
 *     `{ emoji: [userId] }` map; the old `readBy` list is rebuilt from read positions.
 *
 * What it can't carry back: features the old app doesn't have (sticker packs, custom emoji,
 * admin rights and member permissions, profile photo lists and videos, folders, contacts).
 * Their messages still arrive as ordinary messages. Files uploaded in this app live in its own
 * uploads volume; the shell wrapper copies them into the old app's volume so links keep working.
 *
 * Writes are upserts by `_id`, so it's safe to re-run.
 */
import "dotenv/config";
import {
  MongoClient,
  ObjectId,
  AnyBulkWriteOperation,
  Document,
} from "mongodb";

const DRY_RUN = process.argv.includes("--dry-run");
const sinceArg = process.argv
  .find(a => a.startsWith("--since="))
  ?.slice("--since=".length);

const NEW_URI = process.env.DATABASE_URL;
const OLD_URI = process.env.DATABASE_URL_LEGACY;
if (!NEW_URI)
  throw new Error(
    "DATABASE_URL is not set (this app's database, read-only source).",
  );
if (!OLD_URI)
  throw new Error(
    "DATABASE_URL_LEGACY is not set (the old app's database, target).",
  );

const USER_FIELDS = [
  "firstName",
  "lastName",
  "username",
  "email",
  "phoneNumber",
  "bio",
  "password",
  "isDeleted",
  "lastSeen",
  "bigEmojis",
  "quickReaction",
];
const MESSAGE_FIELDS = [
  "channelId",
  "senderId",
  "content",
  "type",
  "attachments",
  "replyTo",
  "isEdited",
  "isDeleted",
  "isPinned",
  "deletedFor",
  "forwardFrom",
  "createdAt",
  "updatedAt",
];
const CHAT_FIELDS = [
  "name",
  "description",
  "type",
  "image",
  "link",
  "admins",
  "createdAt",
  "updatedAt",
  "isPublic",
];
const MEMBER_FIELDS = [
  "channelId",
  "userId",
  "role",
  "isMuted",
  "isPinned",
  "isBanned",
  "isJoined",
  "lastReadMessageId",
  "lastReadAt",
  "createdAt",
  "updatedAt",
];

/** The old app stored full media links; relative `/uploads/...` ones get this origin back
 *  (e.g. https://chat.example.com). Unset → links are copied as they are. */
const MEDIA_ORIGIN = (process.env.LEGACY_MEDIA_ORIGIN ?? "").replace(
  /\/+$/,
  "",
);
const absolute = (url: unknown) =>
  MEDIA_ORIGIN && typeof url === "string" && url.startsWith("/uploads/")
    ? MEDIA_ORIGIN + url
    : url;

const pick = (doc: Document, fields: string[]) =>
  Object.fromEntries(
    fields.filter(f => doc[f] !== undefined).map(f => [f, doc[f]]),
  );

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
  const newClient = await MongoClient.connect(NEW_URI!);
  const oldClient = await MongoClient.connect(OLD_URI!);
  const src = newClient.db();
  const dst = oldClient.db();

  const meta = await src
    .collection("migration_meta")
    .findOne({ _id: "legacy-import" as unknown as ObjectId });
  const since = sinceArg
    ? new Date(sinceArg)
    : (meta?.importedAt as Date | undefined);
  if (!since || Number.isNaN(since.getTime())) {
    throw new Error(
      "No start point: pass --since=<ISO date> (no migration_meta.legacy-import record found).",
    );
  }
  console.log(
    `Copying changes made since ${since.toISOString()}${DRY_RUN ? " (dry run)" : ""}`,
  );
  const changed = {
    $or: [{ createdAt: { $gt: since } }, { updatedAt: { $gt: since } }],
  };
  const report: Record<string, number> = {};

  // users
  const userOps: AnyBulkWriteOperation<Document>[] = [];
  for await (const u of src.collection("user").find(changed)) {
    const set: Document = pick(u, USER_FIELDS);
    if (Array.isArray(u.image)) set.avatarUrl = u.image.map(absolute);
    userOps.push({
      updateOne: {
        filter: { _id: u._id },
        update: {
          $set: set,
          $setOnInsert: { createdAt: u.createdAt ?? new Date() },
        },
        upsert: true,
      },
    });
  }
  report.users = userOps.length;
  await flush(dst, "user", userOps);

  // chats + memberships
  const chatOps: AnyBulkWriteOperation<Document>[] = [];
  for await (const c of src.collection("chats").find(changed)) {
    chatOps.push({
      updateOne: {
        filter: { _id: c._id },
        update: { $set: pick(c, CHAT_FIELDS) },
        upsert: true,
      },
    });
  }
  report.chats = chatOps.length;
  await flush(dst, "chats", chatOps);
  const memberOps: AnyBulkWriteOperation<Document>[] = [];
  for await (const m of src.collection("chatmembers").find(changed)) {
    memberOps.push({
      updateOne: {
        filter: { channelId: m.channelId, userId: m.userId },
        update: { $set: pick(m, MEMBER_FIELDS) },
        upsert: true,
      },
    });
  }
  report.memberships = memberOps.length;
  await flush(dst, "chatmembers", memberOps);

  // messages (+ reactions and readBy in the old shape)
  const lastRead = new Map<string, Map<string, Date>>(); // channelId → userId → lastReadAt
  for await (const m of src
    .collection("chatmembers")
    .find(
      { lastReadAt: { $ne: null } },
      { projection: { channelId: 1, userId: 1, lastReadAt: 1 } },
    )) {
    const ch = String(m.channelId);
    if (!lastRead.has(ch)) lastRead.set(ch, new Map());
    lastRead.get(ch)!.set(String(m.userId), m.lastReadAt as Date);
  }
  // A reaction added to an older message doesn't touch the message itself, so include those too.
  const reacted = (
    await src
      .collection("message_reactions")
      .distinct("messageId", { createdAt: { $gt: since } })
  )
    .filter(id => ObjectId.isValid(String(id)))
    .map(id => new ObjectId(String(id)));
  const msgOps: AnyBulkWriteOperation<Document>[] = [];
  for await (const m of src
    .collection("messages")
    .find({ $or: [...changed.$or, { _id: { $in: reacted } }] })) {
    const reactions: Record<string, string[]> = {};
    for await (const r of src
      .collection("message_reactions")
      .find({ messageId: String(m._id), emoji: { $ne: null } })) {
      (reactions[r.emoji as string] ??= []).push(String(r.userId));
    }
    const readBy = [
      ...(lastRead.get(String(m.channelId)) ?? new Map<string, Date>()),
    ]
      .filter(
        ([userId, at]) => at >= m.createdAt && userId !== String(m.senderId),
      )
      .map(([userId]) => userId);
    const set: Document = { ...pick(m, MESSAGE_FIELDS), reactions, readBy };
    if (Array.isArray(set.attachments))
      set.attachments = set.attachments.map(absolute);
    if (m.type !== "text") set.content = absolute(set.content);
    // Types the old app doesn't know become a file or plain text message.
    if (m.type === "video_note") set.type = "video";
    if (m.type === "sticker") set.type = "image";
    if (!set.content && (!set.attachments || set.attachments.length === 0))
      set.content = "";
    msgOps.push({
      updateOne: {
        filter: { _id: m._id },
        update: { $set: set },
        upsert: true,
      },
    });
  }
  report.messages = msgOps.length;
  await flush(dst, "messages", msgOps);

  console.table(Object.entries(report).map(([what, n]) => ({ what, n })));
  console.log(DRY_RUN ? "Dry run — nothing written." : "Done.");
  await newClient.close();
  await oldClient.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
