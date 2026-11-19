// Downloads the pack artwork listed in manifest.json into ./files/<slug>/ (not committed).
//   node fetch-packs.mjs
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const { packs } = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const url = (pack, key) => pack.source === "noto"
  ? `https://fonts.gstatic.com/s/e/notoemoji/latest/${key}/512.webp`
  : `https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/${encodeURIComponent(key)}/3D/${key.toLowerCase().replace(/ /g, "_")}_3d.png`;
for (const pack of packs) {
  const dir = join(HERE, "files", pack.slug); mkdirSync(dir, { recursive: true });
  let ok = 0; const missing = [];
  for (const [key] of pack.items) {
    const file = join(dir, `${key.toLowerCase().replace(/ /g, "_")}.${pack.source === "noto" ? "webp" : "png"}`);
    if (existsSync(file)) { ok++; continue; }
    let body = null;
    for (let attempt = 1; attempt <= 3 && !body; attempt++) {
      try {
        const res = await fetch(url(pack, key), { signal: AbortSignal.timeout(30_000) });
        if (res.status === 404) break;
        if (res.ok) body = Buffer.from(await res.arrayBuffer());
      } catch { /* timeout or reset: retry */ }
    }
    if (!body) { missing.push(key); continue; }
    writeFileSync(file, body); ok++;
  }
  console.log(`${pack.slug}: ${ok}/${pack.items.length}${missing.length ? "  missing: " + missing.join(", ") : ""}`);
}
