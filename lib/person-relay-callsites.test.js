// @ts-check
// Guard: person-scoped ctx.call relays must bind through personCallOpts (lib/person-relay.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["core", "lib/views"];
const SKIP = /\.(test|spec)\./;
/** Raw `{ as: meta.caller }` on ctx.call — use personCallOpts(meta.caller, meta) instead. */
const BAD = /\bctx\.call\([^)]+\{\s*as:\s*meta(?:\s*&&\s*meta\.caller|\.caller)/;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".js") && !SKIP.test(name)) out.push(p);
  }
  return out;
}

test("person relay: no raw meta.caller as opts on ctx.call in core/views", () => {
  const hits = [];
  for (const rel of SCAN) {
    const base = path.join(root, rel);
    if (!fs.existsSync(base)) continue;
    for (const file of walk(base)) {
      const text = fs.readFileSync(file, "utf8");
      if (text.includes("person-relay.js")) continue;
      if (BAD.test(text)) hits.push(path.relative(root, file));
    }
  }
  assert.deepEqual(hits, [], `use personCallOpts from lib/person-relay.js:\n${hits.join("\n")}`);
});
