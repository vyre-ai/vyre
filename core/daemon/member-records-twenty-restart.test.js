// @ts-check
// The member door on the REAL Twenty record store, with the daemon restarted in the middle (VYRE_STORE=auto provisions a Space's own Twenty; with VYRE_TWENTY_GOLDEN_DIR the first start takes about a minute).
// The same member steps run before and after the restart: Ben reads and changes none of the kept records (skill, Flow definition and approval) by the door, by his session token, or in the activity log; the owner and the
// keeper still read all of them. After the restart the store's attribute map is empty, so the log is the only memory of who made a row: nothing may flip either way. Run on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "./index.js";
import { tempHome } from "../../test/helpers.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { WIRE_VERSION } from "../../kernel/remote/wire.js";
import { createMemberTools } from "../work/member-tools.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const skill = (/** @type {string} */ name, /** @type {string} */ says) => `---\nname: ${name}\ndescription: Use this when the person asks about ${name}, which is ${says}\n---\n${says}\n`;
const SECRET = ["OWNER-PRIVATE-TEXT", "SPACE-DRAFT-TEXT", "ANA-PRIVATE-TEXT", "OWNER-FLOW-MARKER"];
const leaks = (/** @type {any} */ x) => { const s = JSON.stringify(x === undefined ? null : x); return SECRET.filter(w => s.includes(w)); };
const nothing = (/** @type {any} */ r) => {
  if (r === undefined || r === null) return true;
  if (r.ok === false || r.error) return true;
  const v = r.ok === true ? r.v : r.data !== undefined ? r.data : r;
  if (leaks(v).length) return false;
  if (v && Array.isArray(v.rows) && v.rows.length === 0 && Object.keys(v).every(k => /^(rows|acted_in|next_cursor|truncated|links?|total|count|groups?)$/.test(k))) return true;   // the Twenty store answers an empty search as { rows: [] }
  return v === null || v === undefined || v.record === null || v.reference === null || v.data === null || (typeof v === "object" && Object.keys(v).every(k => /^(acted_in|next_cursor|truncated|links?|total|count|groups?)$/.test(k)));
};
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** The record store can still be settling after it first answered (modules define their types for minutes): an owner call that finds it away is tried again for ten minutes. @param {any} w @param {string} tool @param {any} input */
async function ow(w, tool, input) {
  const t0 = Date.now();
  for (;;) {
    const r = await w.asOwner(tool, input);
    if (r && r.error && /did not answer|unavailable|not ready/i.test(JSON.stringify(r.error)) && Date.now() - t0 < 600_000) { await sleep(10_000); continue; }
    return r;
  }
}

/** @param {string} root */
async function boot(root) {
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  const OWNER = d.kernel.id.owner, SPACE = d.kernel.id.space, K = d.kernel;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const chainOf = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "relay" });
  const tokenOf = async (/** @type {any} */ chain) => ({ token: (await K.surfaces.open(chain, {})).token });
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", await tokenOf(ownerChain));
  const server = createRemoteServer({ space: SPACE, kernel: K, services: {} });
  let n = 0;
  const door = async (/** @type {string} */ person, /** @type {string} */ call, /** @type {any[]} */ ...args) => {
    const r = await server.serve({ v: WIRE_VERSION, id: "r" + (++n), space: SPACE, ts: Date.now(), call, args }, { device_key_id: "dev-" + person.slice(4, 10), person, path: "relay" });
    return r.ok ? { ok: true, v: r.result } : { ok: false, e: `${r.error.code}: ${r.error.message}` };
  };
  const svc = K.gateway.serviceChain("skills");
  // the record store (and the types the modules define on it) can take minutes to be there
  const t0 = Date.now(); let last = "";
  for (;;) {
    try { await K.gateway.records.query(svc, "skill", { page: { limit: 1 } }); await K.gateway.records.query(K.gateway.serviceChain("flows"), "def-flow", { page: { limit: 1 } }); break; } catch (e) { last = String(e && /** @type {any} */ (e).message); }
    if (Date.now() - t0 > 1_500_000) throw new Error("the record store and its types were not ready in 25 minutes: " + last);
    await sleep(5000);
  }
  return { d, K, OWNER, SPACE, ownerChain, chainOf, tokenOf, asOwner, door, svc };
}

/** Every member step, and the owner's and keeper's controls. @param {any} w @param {string} when @param {{ ids: any[], flowId: string }} seed */
async function steps(w, when, seed) {
  const B = async (/** @type {string} */ call, /** @type {any[]} */ ...a) => { const r = await w.door(BEN, call, ...a); if (!nothing(r)) console.log("LEAKY", when, call, JSON.stringify(a).slice(0, 120), "=>", JSON.stringify(r).slice(0, 600)); return r; };
  for (const r of seed.ids) {
    assert.ok(nothing(await B("records.get", "skill", r.id)), `${when}: get ${r.data.name}`);
    assert.equal((await B("records.update", "skill", r.id, { state: "approved", body: skill(r.data.name, "INJECTED-BY-BEN") }, r.version)).ok, false, `${when}: update ${r.data.name}`);
    assert.equal((await B("records.remove", "skill", r.id, r.version)).ok, false, `${when}: remove ${r.data.name}`);
  }
  assert.ok(nothing(await B("records.query", "skill", { page: { limit: 50 } })), `${when}: query skill`);
  assert.ok(nothing(await B("records.aggregate", "skill", { group_by: "state" })), `${when}: aggregate skill`);
  for (const text of ["OWNER-PRIVATE-TEXT", "SPACE-DRAFT-TEXT", "ANA-PRIVATE-TEXT", "OWNER-FLOW-MARKER"]) assert.ok(nothing(await B("records.search", { text, page: { limit: 20 } })), `${when}: search ${text}`);
  assert.ok(nothing(await B("records.definitions")), `${when}: the list of types leaves the kept ones out`);
  for (const spec of [{}, { limit: 500 }, { since: 0 }]) assert.ok(nothing(await B("events.read", spec)), `${when}: events.read ${JSON.stringify(spec)}`);
  const bt = await w.tokenOf(w.chainOf(BEN));
  for (const [tool, input] of [["records.query", { type: "skill", page: { limit: 50 } }], ["records.search", { text: "OWNER-PRIVATE-TEXT" }]]) {
    const r = await w.d.registry.call(tool, input, "cli", bt);
    assert.ok(!leaks(r).length, `${when}: ${tool} with his own token leaks nothing`);
  }
  // the owner and the keeper still read everything
  const list = (await w.asOwner("skills.list", {})).data;
  for (const r of seed.ids) assert.ok(list.skills.some((/** @type {any} */ s) => String(s.id).endsWith("/" + r.data.name)) || r.data.name === "space-draft", `${when}: the owner's skill list holds ${r.data.name}`);
  const kept = (await w.K.gateway.records.query(w.svc, "skill", { page: { limit: 50 } })).rows;
  for (const r of seed.ids) assert.ok(kept.some((/** @type {any} */ x) => x.id === r.id), `${when}: the keeper still reads ${r.data.name}`);
  assert.deepEqual(((await w.asOwner("flows.list", {})).data).map((/** @type {any} */ f) => f.id), [seed.flowId], `${when}: the owner's Flow`);
  const oe = await w.door(w.OWNER, "events.read", {});
  assert.ok(oe.ok && JSON.stringify(oe.v).includes("OWNER-PRIVATE-TEXT"), `${when}: the owner still reads the log`);
}

test("TWENTY: the member door refuses Ben everything kept, before and after a daemon restart; the owner and the keeper are served both times", { timeout: 2_400_000 }, async t => {
  assert.equal(process.env.VYRE_STORE, "auto", "this test is for the Twenty store: run it with VYRE_STORE=auto");
  const root = tempHome(t);
  let w = await boot(root);
  t.after(async () => { try { await w.d.stop(); } catch {} });
  for (const person of [ANA, BEN]) await w.K.gateway.grants.setRole(w.ownerChain, { person, role: "member" }, { presence: proof() });
  const p = await ow(w, "skills.draft", { name: "owner-secret", level: "personal", body: skill("owner-secret", "OWNER-PRIVATE-TEXT") });
  assert.ok(!p.error, JSON.stringify(p.error));
  assert.ok(!(await ow(w, "skills.approve", { name: "owner-secret", level: "personal", version: p.data.version })).error);
  const live = await ow(w, "skills.draft", { name: "space-live", level: "space", body: skill("space-live", "SPACE-LIVE-TEXT") });
  assert.ok(!(await ow(w, "skills.approve", { name: "space-live", level: "space", version: live.data.version })).error);
  assert.ok(!(await ow(w, "skills.draft", { name: "space-draft", level: "space", body: skill("space-draft", "SPACE-DRAFT-TEXT") })).error);
  const skillsDoor = createMemberTools({ space: w.SPACE, kernel: w.K, registry: w.d.registry }).skills;
  const a1 = await skillsDoor.draft(w.chainOf(ANA), { name: "ana-private", level: "personal", body: skill("ana-private", "ANA-PRIVATE-TEXT") });
  await skillsDoor.approve(w.chainOf(ANA), { name: "ana-private", level: "personal", version: a1.version });
  const fl = await ow(w, "flows.define", { flow: { format: 1, name: "owner_flow", label: "OWNER-FLOW-MARKER", authorship: "human", trigger: { on: "manual" }, steps: [] } });
  assert.ok(fl.data && fl.data.ok, JSON.stringify(fl.error || fl.data));
  assert.ok(!(await ow(w, "flows.approve", { id: fl.data.id, version: fl.data.version, hash: fl.data.hash })).error);
  const kept = (await w.K.gateway.records.query(w.svc, "skill", { page: { limit: 50 } })).rows;
  const ids = ["owner-secret", "space-draft", "space-live", "ana-private"].map(n => { const r = kept.find((/** @type {any} */ x) => x.data.name === n); assert.ok(r, `the library holds ${n}`); return r; });
  const seed = { ids, flowId: fl.data.id };
  await steps(w, "before the restart", seed);
  // ONE restart of the daemon on the same home: the Twenty store is reattached, its attribute map is empty
  await w.d.stop();
  w = await boot(root);
  await steps(w, "after the restart", seed);
});
