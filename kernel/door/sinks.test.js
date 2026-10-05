// @ts-check
// "Nothing else may reach a model" (contract 8.4): CI fails if a file outside the sink registry names a model provider's host. A new file
// that talks to a model is a new sink: it goes in sinks.json with reviewer-2's sign-off and calls kernel/door. The list may only shrink
// (retrofit_pending empties as sessions and voice move behind the door).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "sinks.json"), "utf8"));
const ROOTS = ["core", "harness", "local", "lib", "modules", "relay", "names", "apps/app/src", "apps/app/app", "box", "web", "packages", "tools"];
// Only the repo's own test roots are skipped, so a provider call hidden in a folder that happens to be named `build` or `testing` is still seen.
const SKIP = /(^|\/)node_modules\/|^(web\/test|apps\/test|test)\//;
const allowed = new Set([...reg.door_clients, ...reg.retrofit_pending, ...Object.keys(reg.not_inference)]);

function* walk(d) {
  let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) { const p = path.join(d, e.name), rel = path.relative(REPO, p); if (SKIP.test(rel + "/")) continue; if (e.isDirectory()) yield* walk(p); else if (/\.(m?js|ts|tsx|swift|kt|rs|sh)$/.test(e.name) && !/\.test\./.test(e.name)) yield rel; }
}

test("only registered files name a model provider host", () => {
  const re = new RegExp(reg.hosts.map(h => h.replace(/\./g, "\\.")).join("|")), sdk = new RegExp(`(?:from|require\\(|import\\()\\s*["'](?:${reg.sdks.map(x => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})["'/]`);
  const loose = [];
  for (const r of ROOTS) for (const f of walk(path.join(REPO, r))) { const t = fs.readFileSync(path.join(REPO, f), "utf8"); if ((re.test(t) || sdk.test(t)) && !allowed.has(f)) loose.push(f); }
  assert.deepEqual(loose, [], "these files talk to a model provider outside the door: route them through kernel/door or register them in kernel/door/sinks.json");
});

test("every registered file still exists and still names a provider (the list only shrinks)", () => {
  const re = new RegExp(reg.hosts.map(h => h.replace(/\./g, "\\.")).join("|")), stale = [];
  for (const f of allowed) { const p = path.join(REPO, f); if (!fs.existsSync(p) || !re.test(fs.readFileSync(p, "utf8"))) stale.push(f); }
  assert.deepEqual(stale, [], "remove these from sinks.json");
});
