// The chat's avatar art, from app-design's set (team/0.3/assets/avatars, dark and paper) into
// src/chat/avatar-art.generated.ts, until @vyre/ui's Avatar ports the generators. One lookup,
// keyed "<family>/<name>/<scheme>". The -wink ring variants are left out (avatar card only).
//
//   node scripts/gen-chat-avatars.mjs [assetsDir]   write the file
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = process.argv[2] || path.resolve(here, "../../../../team/0.3/assets/avatars");
const out = {};
for (const [dir, family] of [["people", "person"], ["assistants", "assistant"]]) {
  for (const f of readdirSync(path.join(assets, dir)).sort()) {
    const m = /^([a-z0-9]+)-(dark|paper)\.svg$/.exec(f);
    if (!m) continue;
    out[`${family}/${m[1]}/${m[2]}`] = readFileSync(path.join(assets, dir, f), "utf8").replace(/\s*\n\s*/g, " ").trim();
  }
}
const body = "// generated from team/0.3/assets/avatars by apps/app/scripts/gen-chat-avatars.mjs; do not edit\nexport const AVATAR_ART: Record<string, string> = " + JSON.stringify(out, null, 1) + ";\n";
writeFileSync(path.join(here, "../src/chat/avatar-art.generated.ts"), body);
console.log(Object.keys(out).length + " marks");
