#!/usr/bin/env node
// Local development seed — idempotent, safe to re-run. Talks to a *running*
// backend over its public API (no direct DB access), so everything goes
// through the same validation, media pipeline and auth rules as the app.
//
//   node backend/scripts/dev-seed/seed-dev.mjs            # API at http://localhost:3001
//   API_URL=http://localhost:3097 node backend/scripts/dev-seed/seed-dev.mjs
//
// Creates (if missing):
//   • three test accounts — see docs/DEV_TEST_ACCOUNTS.md for the logins
//   • a direct chat Maya ↔ Omid and a private group "Weekend trip" with all three
//   • two *public* chats Maya is not in, to try search → preview → Join:
//     channel "Family Recipes" (Sara) and group "Book Club" (Omid)
//   • four demo packs owned by Maya, built from ./packs/*:
//     "Family Moments" + "Celebrations" (stickers),
//     "Animated Faces" + "Quick Reactions" (animated emoji)
//     — two of each so the picker's jump row has more than one section
//   • both packs added to every test account's collection
// Never run against production: the accounts use a shared, published password.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.API_URL ?? "http://localhost:3001";
const PASSWORD = process.env.DEV_SEED_PASSWORD ?? "UiRedesign#2026test";
const HERE = dirname(fileURLToPath(import.meta.url));

const ACCOUNTS = [
  { username: "uid_maya", firstName: "Maya", lastName: "Rahimi" },
  { username: "uid_omid", firstName: "Omid", lastName: "Karimi" },
  { username: "uid_sara", firstName: "Sara", lastName: "Ahmadi" },
];

const STICKERS = {
  love: ["🥰", "love", "hearts", "aww"], hug: ["🤗", "hug", "hugs", "thanks"], heart: ["❤️", "heart", "love"],
  party: ["🎉", "party", "congrats", "yay"], cake: ["🎂", "birthday", "cake", "happy birthday"], home: ["🏡", "home", "house", "coming home"],
  kiss: ["😘", "kiss", "love you"], laugh: ["😆", "lol", "haha", "laugh"], cry: ["😭", "cry", "sad", "miss you"],
  sleep: ["😴", "sleep", "good night", "tired"], wow: ["🤩", "wow", "amazing", "star"], gift: ["🎁", "gift", "present", "surprise"],
  thumbs: ["👍", "ok", "yes", "thumbs up", "good"],
};
const CELEBRATIONS = {
  party: ["🎉", "party"], cake: ["🎂", "birthday"], gift: ["🎁", "gift"], wow: ["🤩", "wow"],
};
const QUICK_REACTIONS = {
  fire: ["🔥", "fire"], tada: ["🎉", "yay"], thumbs_up: ["👍", "ok"], cool: ["😎", "cool"], wave: ["👋", "hi"],
};
const ANIMATED = {
  joy: ["😂", "lol", "haha", "laugh"], heart_eyes: ["😍", "love", "beautiful"], red_heart: ["❤️", "heart", "love"],
  smiling_hearts: ["🥰", "love", "aww"], partying: ["🥳", "party", "celebrate"], thumbs_up: ["👍", "ok", "yes"],
  fire: ["🔥", "fire", "hot", "lit"], tada: ["🎉", "congrats", "yay"], sob: ["😭", "cry", "sad"],
  thinking: ["🤔", "hmm", "thinking"], wave: ["👋", "hi", "hello", "bye"], cool: ["😎", "cool"], kiss: ["😘", "kiss", "love you"],
};

async function call(path, { token, method = "GET", body } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(API + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !isForm ? { "content-type": "application/json" } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`), { status: res.status });
  return data;
}

async function signIn({ username, firstName, lastName }) {
  const email = `${username}@example.test`;
  try {
    return (await call("/auth/login", { method: "POST", body: { email, password: PASSWORD } })).access_token;
  } catch {
    const r = await call("/auth/register", { method: "POST", body: { email, username, password: PASSWORD, firstName, lastName } });
    console.log(`  created account ${email}`);
    return r.access_token;
  }
}

async function ensurePack(token, { type, name, slug, description, tags, dir, ext, items }) {
  const mine = await call(`/v1/packs/mine?type=${type}`, { token });
  let pack = mine.find((p) => p.isOwner && p.name === name);
  if (!pack) {
    pack = await call("/v1/packs", { token, method: "POST", body: { type, name, slug, description, tags, isPublic: true } });
    console.log(`  created pack "${name}" (${pack.slug})`);
  }
  const detail = await call(`/v1/packs/${pack.id}`, { token });
  if (detail.itemCount < Object.keys(items).length) {
    for (const [file, keywords] of Object.entries(items).slice(detail.itemCount)) {
      const form = new FormData();
      form.append("files", new Blob([readFileSync(join(HERE, "packs", dir, `${file}.${ext}`))], { type: ext === "png" ? "image/png" : "image/webp" }), `${file}.${ext}`);
      form.append("keywords", JSON.stringify(keywords));
      await call(`/v1/packs/${pack.id}/items`, { token, method: "POST", body: form });
    }
    console.log(`  "${name}": uploaded items`);
  }
  return pack;
}

console.log(`Seeding ${API} …`);
const tokens = {};
const ids = {};
for (const account of ACCOUNTS) {
  tokens[account.username] = await signIn(account);
  ids[account.username] = (await call("/v1/auth/me", { token: tokens[account.username] }))._id;
}

const maya = tokens.uid_maya;
await call(`/chats/direct/${ids.uid_omid}`, { token: maya });
const chats = await call("/v1/channels/mine", { token: maya });
if (!(chats.items ?? []).some((c) => c.name === "Weekend trip")) {
  await call("/chats/create", {
    token: maya,
    method: "POST",
    body: { name: "Weekend trip", link: `weekend-trip-${Date.now()}`, type: "group", members: [ids.uid_omid, ids.uid_sara], admins: [], description: "Planning the north coast weekend" },
  });
  console.log('  created group "Weekend trip"');
}

// Public chats someone else owns, so the searcher sees "Join" rather than "Open".
async function ensurePublic(token, username, { name, link, type, description }) {
  const mine = await call("/v1/channels/mine", { token });
  if ((mine.items ?? []).some((c) => c.name === name)) return;
  await call("/chats/create", { token, method: "POST", body: { name, link, type, isPublic: true, members: [], admins: [], description } });
  console.log(`  created public ${type} "${name}" (@${link}) owned by ${username}`);
}
await ensurePublic(tokens.uid_sara, "uid_sara", {
  name: "Family Recipes", link: "family_recipes", type: "channel", description: "Grandma's recipes, one a week",
});
await ensurePublic(tokens.uid_omid, "uid_omid", {
  name: "Book Club", link: "book_club", type: "group", description: "One book a month, spoilers in threads",
});

const packs = [
  await ensurePack(maya, {
    type: "sticker", name: "Family Moments", slug: "family-moments",
    description: "Everyday family moments. Artwork: Microsoft Fluent Emoji (MIT License, © Microsoft).",
    tags: ["family", "love", "3d", "fluent"], dir: "stickers", ext: "png", items: STICKERS,
  }),
  await ensurePack(maya, {
    type: "emoji", name: "Animated Faces", slug: "animated-faces",
    description: "Animated emoji for quick reactions. Artwork: Google Noto Animated Emoji, CC BY 4.0 (fonts.google.com/noto/specimen/Noto+Color+Emoji).",
    tags: ["animated", "faces", "noto"], dir: "animated", ext: "webp", items: ANIMATED,
  }),
  await ensurePack(maya, {
    type: "sticker", name: "Celebrations", slug: "celebrations",
    description: "Birthdays, parties and surprises. Artwork: Microsoft Fluent Emoji (MIT License, © Microsoft).",
    tags: ["party", "birthday", "fluent"], dir: "stickers", ext: "png", items: CELEBRATIONS,
  }),
  await ensurePack(maya, {
    type: "emoji", name: "Quick Reactions", slug: "quick-reactions",
    description: "The everyday handful. Artwork: Google Noto Animated Emoji, CC BY 4.0.",
    tags: ["reactions", "noto"], dir: "animated", ext: "webp", items: QUICK_REACTIONS,
  }),
];
for (const username of ["uid_omid", "uid_sara"]) {
  for (const pack of packs) await call(`/v1/packs/${pack.id}/subscribe`, { token: tokens[username], method: "POST" });
}
console.log("Done. Logins: docs/DEV_TEST_ACCOUNTS.md");
