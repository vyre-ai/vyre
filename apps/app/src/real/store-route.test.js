import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createStoreRoute } from "./store-route.js";
import { TOOLS } from "../store-core/gateway-adapter.js";
import { MEMBER_ROWS } from "./member-routes.generated.js";

/** Every name the Store calls (store-core/gateway-adapter.js TOOLS). */
const STORE_NAMES = Object.values(TOOLS);
const rig = (/** @type {string | null} */ joined) => {
  const seen = /** @type {string[]} */ ([]);
  const wired = new Set(MEMBER_ROWS);
  const r = createStoreRoute({
    joinedSpace: async () => joined,
    door: async (n) => { seen.push(`door:${n}`); return { ok: n }; },
    wired: (n) => wired.has(n),
    notYet: "Doing this in the team is the owner's for now.",
    plain: { read: async (n) => { seen.push(`plain-read:${n}`); return { ok: n }; }, write: async (n) => { seen.push(`plain-write:${n}`); return { ok: n }; } },
  });
  return { r, seen };
};

test("with no joined team (her own home, the owner's Space, All spaces) every name the Store uses takes today's call and send path, and never the door", async () => {
  const { r, seen } = rig(null);
  for (const n of STORE_NAMES) { await r.read(n, {}); await r.write(n, {}, {}); }
  assert.equal(seen.filter((s) => s.startsWith("door:")).length, 0);
  assert.deepEqual(seen.filter((s) => s.startsWith("plain-read:")).map((s) => s.slice(11)), STORE_NAMES);
  assert.deepEqual(seen.filter((s) => s.startsWith("plain-write:")).map((s) => s.slice(12)), STORE_NAMES);
});

test("with a joined team named, a name the door has a row for goes to the door; a name it has none for is refused in words and never reaches her own home", async () => {
  const { r, seen } = rig("spc_abcdefghijkl");
  const ROWS = STORE_NAMES.filter((n) => MEMBER_ROWS.includes(n));
  const NONE = STORE_NAMES.filter((n) => !MEMBER_ROWS.includes(n));
  assert.ok(ROWS.includes("records.list") && ROWS.includes("records.get") && ROWS.includes("records.events") && ROWS.includes("tasks.list"), "the Store's reads have rows");
  for (const n of ROWS) await r.read(n, {});
  assert.deepEqual(seen, ROWS.map((n) => `door:${n}`));
  seen.length = 0;
  for (const n of NONE) await assert.rejects(() => r.read(n, {}), (e) => e.code === "not_allowed" && /owner's for now/.test(e.message), n);
  for (const n of NONE) await assert.rejects(() => r.write(n, {}, {}), (e) => e.code === "not_allowed", n);
  assert.deepEqual(seen, [], "nothing went anywhere");
  assert.ok(NONE.length > 0, "records.sees-as, seal-put, reveal, define and tasks.decide are the owner's for now");
});

test("store-link.ts: the Store's rpc is the routed one, events stay the plain stream, and the routing decision is made in store-route.js alone", () => {
  const src = fs.readFileSync(new URL("../api/store-link.ts", import.meta.url), "utf8");
  assert.match(src, /const routed = createStoreRoute\(\{/);
  assert.match(src, /export const boxRpc = \{ read: routed\.read, write: routed\.write, events: plainRpc\.events \}/);
  assert.match(src, /plain: \{ read: plainRpc\.read, write: plainRpc\.write \}/);
  assert.equal((src.match(/joinedHere\(/g) || []).length, 1, "one place asks whether a team is joined");
});
