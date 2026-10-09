// @ts-check
// chrome.op: drafts that wait for a proof, operations kept in the site record and called by name, a repair after a drift, a send held, rollback and forget for the person only.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpsTool } from "./ops-tool.js";
import { createSiteStore } from "./standalone/sitestore.js";
import { opsOnly } from "../../lib/site-knowledge.js";
import { learnOperation } from "../../lib/siteops/learn.js";
import * as F from "../../lib/siteops/fixtures.js";

const ORIGIN = "https://app.example.com";
const ser = (/** @type {any} */ x) => JSON.stringify(x);

function rig(/** @type {Record<string, (a: any) => any>} */ handlers = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optool-"));
  const sites = createSiteStore({ dataDir: dir });
  /** @type {any[]} */ const dispatched = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    if (tool === "memory.site.get") return sites.get(input);
    if (tool === "memory.site.put") return sites.put(input);
    if (tool === "memory.site.report") return sites.report(input);
    if (tool === "memory.site.rollback") return sites.rollback(input);
    return { error: { code: "no_such_tool", message: tool } };
  };
  const dispatch = async (/** @type {string} */ op, /** @type {any} */ args) => { dispatched.push([op, args]); if (op === "tabs.use") return { tab: { id: 7 } }; const h = handlers[op]; if (!h) throw new Error(`no handler for ${op}`); return h(args); };
  const tool = createOpsTool({ dispatch, call, originOf: u => { try { return new URL(u).origin; } catch { return ""; } }, isPerson: m => m && m.caller === "cli", denied: (code, message) => Object.assign(new Error(`${code}: ${message}`), { code }), urls: new Map() });
  return { tool, sites, dispatched, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const read = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const send = () => learnOperation({ name: "sendMessage", kind: "send", exchanges: F.pageSend("ada-lovelace", "hello there friend"), exchanges2: F.pageSend("grace-hopper", "second text here"), examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/inbox` } }).operation;
const M = { caller: "mcp" };
const P = { caller: "cli" };

test("learn gives a summary and a draft, never a template; a read is kept only after it answers on an input that was not an example", async () => {
  const op = read();
  const r = rig({ "ops.learn": () => ({ ok: true, operation: op, warnings: [] }), "ops.call": a => ({ ok: true, class: "ok", data: a.inputs.query === "gamma labs" ? [{ name: "gamma labs one" }] : [], op: a.op.name }) });
  try {
    const l = await r.tool.run({ action: "learn", site: ORIGIN, name: "searchPeople", trigger: { url: `${ORIGIN}/search?q={query}` }, examples: [{ query: "alpha corp" }, { query: "beta works" }] }, M);
    assert.match(l.draft, /^d[0-9a-f]{10}$/);
    assert.deepEqual(l.inputs, [{ name: "query", type: "string", required: true }]);
    assert.equal(l.request, "GET app.example.com/api/v2/search");
    assert.deepEqual(l.signedWith, ["session:csrf"]);
    for (const raw of [F.SECRET_COOKIE, F.CSRF, "alpha corp", "x-csrf-token"]) assert.ok(!ser(l).includes(raw), `leaked ${raw}`);
    await assert.rejects(r.tool.run({ action: "save", draft: l.draft }, M), /verify/);
    await assert.rejects(r.tool.run({ action: "save", draft: l.draft, verify: { query: "alpha corp" } }, M), /must differ from the examples/);
    const empty = await r.tool.run({ action: "save", draft: l.draft, verify: { query: "nobody here" } }, M);
    assert.equal(empty.saved, false);
    assert.match(empty.reason, /no data/);
    const saved = await r.tool.run({ action: "save", draft: l.draft, verify: { query: "gamma labs" } }, M);
    assert.equal(saved.saved, true, ser(saved));
    const listed = await r.tool.run({ action: "list", site: ORIGIN }, M);
    assert.deepEqual(listed.operations.map((/** @type {any} */ o) => [o.name, o.kind, o.inputs]), [["searchPeople", "read", ["query"]]]);
    assert.ok(!ser(listed).includes("/api/v2/search"), "the list carries names and inputs, not templates");
  } finally { r.done(); }
});

test("call runs a kept operation by name through the page; an unknown name says what is known", async () => {
  const op = read();
  const r = rig({ "ops.learn": () => ({ ok: true, operation: op, warnings: [] }), "ops.call": a => ({ ok: true, class: "ok", data: [{ name: `${a.inputs.query} one` }], op: a.op.name }) });
  try {
    const l = await r.tool.run({ action: "learn", site: ORIGIN, name: "searchPeople", trigger: op.trigger, examples: [{ query: "alpha corp" }, { query: "beta works" }] }, M);
    await r.tool.run({ action: "save", draft: l.draft, verify: { query: "gamma labs" } }, M);
    const out = await r.tool.run({ action: "call", site: ORIGIN, name: "searchPeople", inputs: { query: "delta inc" } }, M);
    assert.equal(out.ok, true);
    assert.equal(out.data[0].name, "delta inc one");
    assert.equal(r.dispatched.filter(d => d[0] === "tabs.use").length >= 1, true, "a tab on the site is found or opened");
    await assert.rejects(r.tool.run({ action: "call", site: ORIGIN, name: "nope", inputs: {} }, M), /known: searchPeople/);
    assert.equal(r.sites.record(ORIGIN).ops[0].misses, 0);
  } finally { r.done(); }
});

test("a drift is repaired once, kept with a new version and the call answers; a repair that fails counts a miss and says so", async () => {
  const op = read();
  const fixed = structuredClone(op); fixed.response.extract = "items";
  let healOutcome = "healed", calls = 0;
  const r = rig({ "ops.learn": () => ({ ok: true, operation: op, warnings: [] }),
    "ops.call": a => { calls++; return a.op.response.extract === "items" ? { ok: true, class: "ok", data: [{ name: "fixed" }] } : (calls === 1 ? { ok: true, class: "ok", data: [{ name: "v" }] } : { ok: false, class: "drift", reason: "extract path missing", next: "heal" }); },
    "ops.heal": () => (healOutcome === "healed" ? { outcome: "healed", operation: fixed, reason: "relearned" } : { outcome: "failed", reason: "the trigger fired no request" }) });
  try {
    const l = await r.tool.run({ action: "learn", site: ORIGIN, name: "searchPeople", trigger: op.trigger, examples: [{ query: "alpha corp" }, { query: "beta works" }] }, M);
    await r.tool.run({ action: "save", draft: l.draft, verify: { query: "gamma labs" } }, M);
    const healed = await r.tool.run({ action: "call", site: ORIGIN, name: "searchPeople", inputs: { query: "delta inc" } }, M);
    assert.equal(healed.healed, true);
    assert.equal(healed.data[0].name, "fixed");
    const rec = r.sites.record(ORIGIN).ops[0];
    assert.equal(rec.version, 2);
    assert.equal(rec.prev.length, 1);
    // fail case: the stored op is now the fixed one; make it drift again and the repair fail
    healOutcome = "failed";
    const bad = rig({ "ops.call": () => ({ ok: false, class: "drift", reason: "extract path missing" }), "ops.heal": () => ({ outcome: "failed", reason: "the trigger fired no request" }) });
    try {
      await bad.sites.put({ origin: ORIGIN, patch: { key: ORIGIN, ops: [{ name: "searchPeople", kind: "read", op }] } });
      const out = await bad.tool.run({ action: "call", site: ORIGIN, name: "searchPeople", inputs: { query: "delta inc" } }, M);
      assert.equal(out.ok, false);
      assert.equal(out.heal.outcome, "failed");
      assert.match(out.next, /teach it again/);
      assert.equal(bad.sites.record(ORIGIN).ops[0].misses, 1);
    } finally { bad.done(); }
  } finally { r.done(); }
});

test("a send is kept without being run, and every call comes back held; the held answer is the extension's, untouched", async () => {
  const op = send();
  const r = rig({ "ops.learn": () => ({ ok: true, operation: op, warnings: [] }), "ops.call": a => ({ held: true, id: "h1", op: a.op.name, fields: [{ name: "recipient", value: "alan-turing" }] }) });
  try {
    const l = await r.tool.run({ action: "learn", site: ORIGIN, name: "sendMessage", kind: "send", trigger: op.trigger, examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }] }, M);
    assert.match(l.next, /kept without being run/);
    const before = r.dispatched.length;
    const saved = await r.tool.run({ action: "save", draft: l.draft }, M);
    assert.equal(saved.saved, true);
    assert.equal(r.dispatched.slice(before).filter(d => d[0] === "ops.call").length, 0, "saving a send never sends");
    const h = await r.tool.run({ action: "call", site: ORIGIN, name: "sendMessage", inputs: { recipient: "alan-turing", text: "a fresh note" } }, M);
    assert.equal(h.held, true);
    assert.equal(r.sites.record(ORIGIN).ops[0].misses, 0, "a hold is not a miss");
  } finally { r.done(); }
});

test("rollback and forget are the person's; versions list the history", async () => {
  const op = read();
  const v2 = structuredClone(op); v2.response.extract = "items";
  const r = rig();
  try {
    await r.sites.put({ origin: ORIGIN, patch: { key: ORIGIN, ops: [{ name: "searchPeople", kind: "read", op }] } });
    await r.sites.put({ origin: ORIGIN, patch: { key: ORIGIN, ops: [{ name: "searchPeople", kind: "read", op: v2, outcome: "ok" }] } });
    const v = await r.tool.run({ action: "versions", site: ORIGIN, name: "searchPeople" }, M);
    assert.equal(v.current, 2); assert.equal(v.history[0].version, 1);
    await assert.rejects(r.tool.run({ action: "rollback", site: ORIGIN, name: "searchPeople", version: 1 }, M), /only the person/);
    await assert.rejects(r.tool.run({ action: "forget", site: ORIGIN, name: "searchPeople" }, M), /only the person/);
    const back = await r.tool.run({ action: "rollback", site: ORIGIN, name: "searchPeople", version: 1 }, P);
    assert.deepEqual(back, { rolledBack: true, name: "searchPeople", version: 3 });
    assert.equal(r.sites.record(ORIGIN).ops[0].op.response.extract, op.response.extract);
    assert.equal((await r.tool.run({ action: "rollback", site: ORIGIN, name: "searchPeople", version: 99 }, P)).rolledBack, false);
    assert.equal((await r.tool.run({ action: "forget", site: ORIGIN, name: "searchPeople" }, P)).forgotten, true);
    assert.equal(r.sites.record(ORIGIN).ops.length, 0);
  } finally { r.done(); }
});

test("opsOnly: only a patch about taught operations skips the passive-learning switch", () => {
  assert.equal(opsOnly({ key: ORIGIN, ops: [{ name: "a" }] }), true);
  assert.equal(opsOnly({ key: ORIGIN, remove: [{ part: "ops", id: "a" }] }), true);
  assert.equal(opsOnly({ key: ORIGIN, ops: [{}], controls: [{}] }), false);
  assert.equal(opsOnly({ key: ORIGIN, remove: [{ part: "controls", id: "c1" }] }), false);
  assert.equal(opsOnly({ key: ORIGIN }), false);
  assert.equal(opsOnly(null), false);
});
