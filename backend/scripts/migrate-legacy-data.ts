/**
 * One-off migration: copies every collection from a legacy database
 * (DATABASE_URL_LEGACY, read-only) into this project's database (DATABASE_URL).
 *
 * Usage:
 *   npm run migrate:legacy -- --dry-run   # report only, no writes
 *   npm run migrate:legacy                # actually copy
 *
 * Safe to re-run: every write is an upsert keyed on the original `_id`, so cross-collection
 * ObjectId references (senderId, replyTo, chatWallpaperId, ...) keep pointing at the right doc.
 *
 * Deviations from a plain 1:1 copy:
 *   1. `chatmembers` had no unique index in the old DB. Duplicate (channelId,userId) rows are
 *      merged into one before insert (latest `updatedAt` wins; boolean flags are OR'd across the
 *      group so nobody silently loses a restriction like `isBanned`). (B0)
 *   2. The `config-bot` user + its `configs` channel (created by the now-removed
 *      `POST /config-logs` endpoint) are dropped entirely, along with their messages and
 *      memberships. (B0)
 *   3. `chats.banned[]` doesn't exist on the new schema — banning is now
 *      `chatmembers.isBanned` (B2). Each legacy chat's `banned` array is translated into a
 *      synthetic `chatmembers` row (`isBanned: true, isJoined: false`) for anyone who doesn't
 *      already have a row for that channel (the old ban flow deleted the membership row
 *      entirely, so most banned users won't). The `banned` field itself is stripped from the
 *      copied chat document.
 *   4. `user_gifs`, `sticker_packs`, and `app_settings` are NOT copied 1:1 (B9 rewrote all
 *      three): `user_gifs` (a personal library with its own upload/dedupe pipeline) is replaced
 *      by `clips`, a pointer into the real `MediaService`/`media_assets` pipeline — there's no
 *      way to backfill a `MediaAsset` from an old `user_gifs` row without re-ingesting its file,
 *      which this script doesn't attempt. `sticker_packs` changed shape (`creatorId`→`ownerId`,
 *      `stickers: string[]` of raw URLs → a `stickers` sub-collection of `MediaAsset` pointers,
 *      same reason). `app_settings` only ever held the now-removed `trendingGifs` toggle. If you
 *      need old personal GIFs/sticker packs preserved, re-upload them through the new endpoints
 *      by hand — there were no starter/seed packs on the old system worth scripting around.
 *   5. `wallpapers`: the old app created a new doc on every apply with no dedupe (B9 fixed this
 *      going forward — one doc per `(ownerId, channelId)` scope, enforced by a unique index).
 *      Copying every legacy doc as-is would violate that index. Each `(ownerId, channelId)`
 *      group is collapsed to its most-recently-updated doc before insert, exactly like the
 *      `chatmembers` de-dupe below; the rest are dropped (they're superseded applies, not
 *      distinct data). `mediaId` is set to `null` on every migrated wallpaper — the old system
 *      never tracked a `MediaAsset` reference, so the nightly GC simply won't decrement anything
 *      for these when they're eventually replaced or reset, same as any wallpaper set by URL.
 */
import "dotenv/config";
import { MongoClient, ObjectId, Document } from "mongodb";

const DRY_RUN = process.argv.includes("--dry-run");

const LEGACY_URI = process.env.DATABASE_URL_LEGACY;
const NEW_URI = process.env.DATABASE_URL;

if (!LEGACY_URI) {
  throw new Error("DATABASE_URL_LEGACY is not set (read-only source database).");
}
if (!NEW_URI) {
  throw new Error("DATABASE_URL is not set (this project's database, migration target).");
}

/**
 * Plain collections copied 1:1 (minus any doc excluded below). `chats`, `chatmembers`, and
 * `wallpapers` have their own blocks (dedupe/translation needed). `user_gifs`, `sticker_packs`,
 * and `app_settings` are deliberately NOT copied at all — see deviation #4 above.
 */
const PLAIN_COLLECTIONS = [
  "user",
  "blocks",
  "emoji_usage",
  "upload_records",
] as const;

interface Summary {
  collection: string;
  read: number;
  written: number;
  excluded: number;
  deduped: number;
}

async function main() {
  const legacyClient = new MongoClient(LEGACY_URI!);
  const newClient = new MongoClient(NEW_URI!);
  await legacyClient.connect();
  await newClient.connect();

  const legacyDb = legacyClient.db();
  const newDb = newClient.db();

  const summaries: Summary[] = [];

  try {
    // --- Identify the config-bot artifact so it can be excluded everywhere ---
    const configBotUser = await legacyDb
      .collection("user")
      .findOne({ username: "config-bot" });
    const configBotUserId = configBotUser?._id as ObjectId | undefined;

    const configsChat = await legacyDb.collection("chats").findOne({ link: "configs" });
    const configsChannelId = configsChat ? String(configsChat._id) : undefined;

    if (configBotUserId || configsChannelId) {
      console.log(
        `Excluding config-bot artifacts: user=${configBotUserId ?? "(none)"}, ` +
          `configs channel=${configsChannelId ?? "(none)"}`,
      );
    }

    // --- Plain collections ---
    for (const name of PLAIN_COLLECTIONS) {
      const summary: Summary = { collection: name, read: 0, written: 0, excluded: 0, deduped: 0 };
      const docs = await legacyDb.collection(name).find({}).toArray();
      summary.read = docs.length;

      const kept = docs.filter(doc => {
        if (name === "user" && configBotUserId && doc._id.equals(configBotUserId)) return false;
        return true;
      });
      summary.excluded = docs.length - kept.length;
      summary.written = kept.length;

      if (!DRY_RUN && kept.length > 0) {
        await upsertMany(newDb, name, kept);
      }
      summaries.push(summary);
    }

    // --- chats: exclude the configs channel, strip the retired `banned` field, and remember
    //     each channel's banned user ids so they can become synthetic chatmembers rows below ---
    const bannedByChannel = new Map<string, string[]>();
    {
      const summary: Summary = { collection: "chats", read: 0, written: 0, excluded: 0, deduped: 0 };
      const docs = await legacyDb.collection("chats").find({}).toArray();
      summary.read = docs.length;

      const kept = docs.filter(
        doc => !(configsChannelId && String(doc._id) === configsChannelId),
      );
      summary.excluded = docs.length - kept.length;
      summary.written = kept.length;

      const stripped = kept.map(doc => {
        const { banned, ...rest } = doc as Document & { banned?: ObjectId[] };
        if (Array.isArray(banned) && banned.length > 0) {
          bannedByChannel.set(String(doc._id), banned.map(id => String(id)));
        }
        return rest;
      });

      if (!DRY_RUN && stripped.length > 0) {
        await upsertMany(newDb, "chats", stripped);
      }
      summaries.push(summary);
    }

    // --- messages: exclude config-bot's channel + anything it authored ---
    {
      const summary: Summary = { collection: "messages", read: 0, written: 0, excluded: 0, deduped: 0 };
      const docs = await legacyDb.collection("messages").find({}).toArray();
      summary.read = docs.length;

      const kept = docs.filter(doc => {
        if (configsChannelId && String(doc.channelId) === configsChannelId) return false;
        if (configBotUserId && doc.senderId && String(doc.senderId) === String(configBotUserId))
          return false;
        return true;
      });
      summary.excluded = docs.length - kept.length;
      summary.written = kept.length;

      if (!DRY_RUN && kept.length > 0) {
        await upsertMany(newDb, "messages", kept);
      }
      summaries.push(summary);
    }

    // --- chatmembers: exclude config-bot rows/channel, then de-dupe (channelId,userId) ---
    {
      const summary: Summary = {
        collection: "chatmembers",
        read: 0,
        written: 0,
        excluded: 0,
        deduped: 0,
      };
      const docs = await legacyDb.collection("chatmembers").find({}).toArray();
      summary.read = docs.length;

      const kept = docs.filter(doc => {
        if (configsChannelId && String(doc.channelId) === configsChannelId) return false;
        if (configBotUserId && String(doc.userId) === String(configBotUserId)) return false;
        return true;
      });
      summary.excluded = docs.length - kept.length;

      const groups = new Map<string, Document[]>();
      for (const doc of kept) {
        const key = `${doc.channelId}:${doc.userId}`;
        const group = groups.get(key);
        if (group) group.push(doc);
        else groups.set(key, [doc]);
      }

      const merged: Document[] = [];
      for (const group of groups.values()) {
        if (group.length === 1) {
          merged.push(group[0]);
          continue;
        }
        summary.deduped += group.length - 1;
        const winner = [...group].sort(
          (a, b) => toTime(b.updatedAt) - toTime(a.updatedAt),
        )[0];
        const orFlag = (flag: string) => group.some(d => d[flag] === true);
        merged.push({
          ...winner,
          isBanned: orFlag("isBanned"),
          mutedByAdmin: orFlag("mutedByAdmin"),
          isPinned: orFlag("isPinned"),
          isMuted: orFlag("isMuted"),
        });
      }
      summary.written = merged.length;

      // Synthesize a banned-but-not-a-member row for anyone in a legacy chat's `banned[]`
      // who doesn't already have a chatmembers row for that channel (see `chats` block above).
      const existingKeys = new Set(merged.map(d => `${d.channelId}:${d.userId}`));
      const synthesized: Document[] = [];
      for (const [channelId, bannedUserIds] of bannedByChannel) {
        for (const userId of bannedUserIds) {
          const key = `${channelId}:${userId}`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          synthesized.push({
            _id: new ObjectId(),
            channelId,
            userId,
            role: "member",
            isBanned: true,
            isJoined: false,
            isPinned: false,
            isMuted: false,
            mutedByAdmin: false,
            lastReadMessageId: null,
            lastReadAt: null,
            chatWallpaperId: null,
            wallpaperBlur: null,
            wallpaperDim: null,
            wallpaperBrightness: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }
      summary.written += synthesized.length;

      if (!DRY_RUN && (merged.length > 0 || synthesized.length > 0)) {
        await upsertMany(newDb, "chatmembers", [...merged, ...synthesized]);
      }
      summaries.push(summary);
    }

    // --- wallpapers: de-dupe to one doc per (ownerId, channelId) scope (see deviation #5) ---
    {
      const summary: Summary = {
        collection: "wallpapers",
        read: 0,
        written: 0,
        excluded: 0,
        deduped: 0,
      };
      const docs = await legacyDb.collection("wallpapers").find({}).toArray();
      summary.read = docs.length;

      const groups = new Map<string, Document[]>();
      for (const doc of docs) {
        const key = `${String(doc.ownerId)}:${doc.channelId ? String(doc.channelId) : "null"}`;
        const group = groups.get(key);
        if (group) group.push(doc);
        else groups.set(key, [doc]);
      }

      const merged: Document[] = [];
      for (const group of groups.values()) {
        if (group.length > 1) summary.deduped += group.length - 1;
        const winner = [...group].sort(
          (a, b) => toTime(b.updatedAt) - toTime(a.updatedAt),
        )[0];
        merged.push({ ...winner, mediaId: null });
      }
      summary.written = merged.length;

      if (!DRY_RUN && merged.length > 0) {
        await upsertMany(newDb, "wallpapers", merged);
      }
      summaries.push(summary);
    }

    console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}Migration summary`);
    console.table(summaries);
  } finally {
    await legacyClient.close();
    await newClient.close();
  }
}

async function upsertMany(db: ReturnType<MongoClient["db"]>, collection: string, docs: Document[]) {
  const ops = docs.map(doc => ({
    replaceOne: {
      filter: { _id: doc._id },
      replacement: doc,
      upsert: true,
    },
  }));
  await db.collection(collection).bulkWrite(ops, { ordered: false });
}

function toTime(value: unknown): number {
  const d = value instanceof Date ? value : new Date(String(value ?? 0));
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
