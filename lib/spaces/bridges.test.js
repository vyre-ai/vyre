// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BridgeError, BRIDGE_CODES, BRIDGE_ACTIONS, parseUrn, formatUrn, createMemoryBridgeStore, createRefCache, wipeCacheFor,
  proposeView, acceptView, acceptBridge, revokeBridge, readView, proposeReference, resolveReference, proposalHash,
  copyRecord, proposeProjection, projectEvent, kitExport, kitInstallPlan, installKit, continueIn,
  sessionPolicy, checkSessionWrite, checkSessionAct, checkSessionProvider, deriveLabels, assertNoCrossSpacePaste, assertNoForeignContent,
  strictestResidency, inferenceAllowed, normalizeResidency, chainIsExactlyOnePerson,
} from "./bridges.js";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

/** A chain as the kernel would build it (tests only). */
const chain = (/** @type {string} */ space, ...hops) => /** @type {any} */ ({
  space, built_at: T0, labels: { trust: "member", red: "public", source_spaces: [space] },
  hops: (hops.length ? hops : [["person", "alex"]]).map(([kind, id]) => ({ actor: { kind, id, space }, entered_by: "surface" })),
});
const alexH = chain("harlow");
const alexP = chain("alex");
const modelH = chain("harlow", ["person", "alex"], ["agent", "juno"]);
const modelP = chain("alex", ["person", "alex"], ["agent", "juno"]);

const SSN = { sealed: "us-ssn", ref: "vault:abc", present: true, valid_format: true, set_at: 1 };
const contacts = () => [
  { type: "contact", id: "c1", version: 3, created_at: 1, updated_at: 2, data: { name: "Jane Doe", status: "open", email: "jane@example.com", note: "met at the bakery", ssn: SSN, tier: "gold" } },
  { type: "contact", id: "c2", version: 1, created_at: 1, updated_at: 2, data: { name: "Sam Roe", status: "closed", email: "sam@example.com", note: "n/a", ssn: SSN, tier: "silver" } },
];
const SCHEMA = { fields: {
  name: { red: "public", kind: "text", free_text: false }, status: { red: "internal", kind: "choice" }, tier: { red: "internal", kind: "choice" },
  email: { red: "pii", kind: "emails" }, note: { red: "pii", kind: "text" }, ssn: { red: "privileged", kind: "sealed" }, title: { red: "internal", kind: "text", free_text: false },
} };

function evalFilter(/** @type {any} */ f, /** @type {any} */ d) {
  if (!f) return true;
  if (f.and) return f.and.every((/** @type {any} */ x) => evalFilter(x, d));
  if (f.or) return f.or.some((/** @type {any} */ x) => evalFilter(x, d));
  if (f.not) return !evalFilter(f.not, d);
  if (f.op === "eq") return d[f.field] === f.value;
  return true;
}

/** A small world: two Spaces, their records, a log per Space, an authorize that can deny. */
function world(over = {}) {
  let t = T0, n = 0;
  const logs = /** @type {Record<string, any[]>} */ ({ harlow: [], alex: [] });
  const store = /** @type {Record<string, Map<string, any>>} */ ({ harlow: new Map(), alex: new Map() });
  for (const r of contacts()) store.harlow.set(`contact/${r.id}`, r);
  const created = /** @type {any[]} */ ([]); const asks = /** @type {any[]} */ ([]); const queries = /** @type {any[]} */ ([]); const tasks = /** @type {any[]} */ ([]);
  const denied = new Set(); const reasons = new Map();
  const w = {
    logs, created, asks, queries, tasks, denied, reasons, store,
    advance(ms) { t += ms; },
    policies: /** @type {any} */ ({ harlow: { inference: ["anthropic"], secrets: "space_only" }, alex: { inference: "any", secrets: "any" } }),
    deps: /** @type {any} */ ({
      now: () => t,
      newId: (/** @type {string} */ p) => `${p}_${++n}`,
      authorize: async (/** @type {any} */ c, /** @type {string} */ action, /** @type {string} */ res) => {
        const k = `${c.space}|${action}`;
        if (denied.has(k) || denied.has(action)) return { effect: "deny", reason: reasons.get(action) ?? "no_grant" };
        return { effect: "allow", reason: "ok" };
      },
      emit: async (/** @type {string} */ s, /** @type {string} */ type, /** @type {any} */ payload) => { logs[s].push({ type, payload }); },
      records: (/** @type {string} */ s) => ({
        read: async (/** @type {string} */ type, /** @type {string} */ id) => store[s].get(`${type}/${id}`) ?? null,
        query: async (/** @type {string} */ type, /** @type {any} */ spec) => { queries.push({ s, type, spec }); return { rows: [...store[s].values()].filter(r => r.type === type && evalFilter(spec.filter, r.data)) }; },
        create: async (/** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ data, /** @type {any} */ meta) => { const rec = { type, id, version: 1, data, created_at: t, updated_at: t }; store[s].set(`${type}/${id}`, rec); created.push({ s, type, id, data, meta }); return rec; },
      }),
      schema: async (/** @type {string} */ s, /** @type {string} */ type) => (type === "contact" || type === "case.opened" || type === "note" ? SCHEMA : null),
      policy: async (/** @type {string} */ s) => w.policies[s],
      bridges: createMemoryBridgeStore(),
      ask: async (/** @type {string} */ s, /** @type {any} */ card) => { asks.push({ s, card }); return `ask_${asks.length}`; },
      refCache: createRefCache(),
      task: { request: async (/** @type {any} */ c, /** @type {any} */ task) => { const tk = { id: `tk_${tasks.length + 1}`, space: c.space, state: "ready", ...task }; tasks.push(tk); return tk; } },
      destinationChain: async (/** @type {any} */ _c, /** @type {string} */ space) => chain(space),
      vault: { copySealed: async (/** @type {any} */ a) => ({ sealed: "us-ssn", ref: `vault:${a.destination}:new`, present: true, valid_format: true, set_at: 5 }) },
      ...over,
    }),
  };
  return w;
}
const proof = (/** @type {string} */ hash, /** @type {any} */ extra = {}) => ({ signer: "secure_enclave", key_id: "k1", payload_hash: hash, decision: "dec_1", chain_hash: "c", issued_at: T0, expires_at: T0 + HOUR, nonce: "n", signature: "s", ...extra });

const viewInput = (/** @type {any} */ over = {}) => {
  const i = { chain: alexH, source: "harlow", destination: "alex", type: "contact", fields: ["name", "status", "email", "ssn"], max_red: "internal", expires_at: T0 + 24 * HOUR, ...over };
  let h = "unbound"; try { h = proposalHash("view", i); } catch { /* refused proposals need no valid proof */ }
  return { ...i, presence: proof(h) };
};
async function liveView(w, over = {}) {
  const b = await proposeView(viewInput(over), w.deps);
  await acceptView({ chain: alexP, bridgeId: b.id }, w.deps);
  return b;
}
const code = (/** @type {Promise<any>} */ p) => p.then(() => null, (/** @type {any} */ e) => (e instanceof BridgeError ? e.code : "NOT_BRIDGE:" + e));
const sealedAnywhere = (/** @type {any} */ v) => JSON.stringify(v).includes("vault:");

// ------------------------------------------------------------------ basics

test("error codes are the closed list and actions are declared", () => {
  assert.deepEqual([...BRIDGE_CODES].sort(), ["bad_input", "expired", "forbidden", "needs_presence", "not_accepted", "not_found", "revoked", "sealed", "wrong_space"]);
  for (const a of BRIDGE_ACTIONS) assert.match(a.action, /^[a-z]+\.[a-z]+$/);
  assert.equal(BRIDGE_ACTIONS.find(a => a.action === "records.copy")?.risk, "outward.share");
  assert.equal(BRIDGE_ACTIONS.find(a => a.action === "views.share")?.risk, "outward.share");
  assert.equal(BRIDGE_ACTIONS.find(a => a.action === "records.copy")?.action === "views.read", false);
});

test("URN parse and format are strict", () => {
  assert.deepEqual(parseUrn("vyre://harlow/contact/c1"), { space: "harlow", type: "contact", id: "c1" });
  assert.equal(formatUrn({ space: "harlow", type: "contact", id: "c1" }), "vyre://harlow/contact/c1");
  for (const bad of ["vyre://harlow/contact", "vyre://harlow/contact/c1/extra", "http://harlow/contact/c1", "vyre://Harlow/contact/c1", "vyre://harlow/Contact/c1", "vyre://harlow/contact/c 1", "vyre:///contact/c1", "vyre://harlow/contact/c1?x=1", "vyre://harlow/contact/../x", "", 5, null])
    assert.throws(() => parseUrn(/** @type {any} */ (bad)), (/** @type {any} */ e) => e.code === "bad_input", String(bad));
  assert.throws(() => formatUrn({ space: "harlow", type: "contact", id: "" }), /cannot format/);
});

// ------------------------------------------------------------------ lifecycle: two-sided consent, expiry, revoke, logs

test("nothing flows until the destination accepts; proposal leaves a record and an Ask card there", async () => {
  const w = world();
  const b = await proposeView(viewInput(), w.deps);
  assert.equal(b.status, "proposed");
  assert.ok(w.created.some(c => c.s === "alex" && c.type === "bridge_offer" && c.id === b.id), "offer record in the destination");
  assert.equal(w.asks.length, 1); assert.equal(w.asks[0].s, "alex");
  assert.equal(await code(readView(b.id, { chain: alexP }, w.deps)), "not_accepted");
  await acceptView({ chain: alexP, bridgeId: b.id }, w.deps);
  const r = await readView(b.id, { chain: alexP }, w.deps);
  assert.equal(r.rows.length, 2);
  assert.ok(w.created.some(c => c.s === "alex" && c.type === "bridge_acceptance"));
});

test("accept must be made in the destination, and the source cannot accept its own offer", async () => {
  const w = world();
  const b = await proposeView(viewInput(), w.deps);
  assert.equal(await code(acceptView({ chain: alexH, bridgeId: b.id }, w.deps)), "wrong_space");
  assert.equal(await code(acceptView({ chain: alexP, bridgeId: "br_nope" }, w.deps)), "not_found");
  w.denied.add("bridges.accept");
  assert.equal(await code(acceptView({ chain: alexP, bridgeId: b.id }, w.deps)), "forbidden");
  w.denied.delete("bridges.accept");
  await acceptView({ chain: alexP, bridgeId: b.id }, w.deps);
  assert.equal(await code(acceptView({ chain: alexP, bridgeId: b.id }, w.deps)), "bad_input");
});

test("proposal refusals: wrong space, no presence, model chain, bad presence, past expiry, same space, unauthorized", async () => {
  const w = world();
  assert.equal(await code(proposeView({ ...viewInput(), chain: alexP }, w.deps)), "wrong_space");
  assert.equal(await code(proposeView({ ...viewInput(), presence: undefined }, w.deps)), "needs_presence");
  assert.equal(await code(proposeView({ ...viewInput(), chain: modelH }, w.deps)), "forbidden");
  const i = viewInput();
  assert.equal(await code(proposeView({ ...i, presence: proof("other") }, w.deps)), "needs_presence");
  assert.equal(await code(proposeView({ ...i, presence: proof(i.presence.payload_hash, { signer: "click" }) }, w.deps)), "needs_presence");
  assert.equal(await code(proposeView({ ...i, presence: proof(i.presence.payload_hash, { expires_at: T0 - 1 }) }, w.deps)), "needs_presence");
  assert.equal(await code(proposeView(viewInput({ expires_at: T0 - 5 }), w.deps)), "bad_input");
  assert.equal(await code(proposeView(viewInput({ destination: "harlow" }), w.deps)), "bad_input");
  w.denied.add("views.share");
  assert.equal(await code(proposeView(viewInput(), w.deps)), "forbidden");
  assert.equal(w.deps.bridges && (await w.deps.bridges.list()).length, 0);
});

test("a presence proof for one proposal does not cover a widened one", async () => {
  const w = world();
  const narrow = viewInput({ fields: ["name"] });
  const wide = { ...viewInput({ fields: ["name", "email"] }), presence: narrow.presence };
  assert.equal(await code(proposeView(wide, w.deps)), "needs_presence");
});

test("expiry: a share stops at its expiry, for read and for accept", async () => {
  const w = world();
  const b = await liveView(w, { expires_at: T0 + HOUR });
  assert.equal((await readView(b.id, { chain: alexP }, w.deps)).rows.length, 2);
  w.advance(HOUR);
  assert.equal(await code(readView(b.id, { chain: alexP }, w.deps)), "expired");
  const w2 = world();
  const p = await proposeView(viewInput({ expires_at: T0 + HOUR }), w2.deps);
  w2.advance(2 * HOUR);
  assert.equal(await code(acceptView({ chain: alexP, bridgeId: p.id }, w2.deps)), "expired");
});

test("revoke is instant, from either side, idempotent, and refused for a stranger", async () => {
  const w = world();
  const b = await liveView(w);
  assert.equal(await code(revokeBridge({ chain: chain("northwind"), bridgeId: b.id }, w.deps)), "wrong_space");
  await revokeBridge({ chain: alexH, bridgeId: b.id, reason: "done" }, w.deps);
  assert.equal(await code(readView(b.id, { chain: alexP }, w.deps)), "revoked");
  await revokeBridge({ chain: alexP, bridgeId: b.id }, w.deps); // idempotent
  const w2 = world();
  const b2 = await liveView(w2);
  await revokeBridge({ chain: alexP, bridgeId: b2.id }, w2.deps);
  assert.equal(await code(readView(b2.id, { chain: alexP }, w2.deps)), "revoked");
  assert.equal(await code(acceptView({ chain: alexP, bridgeId: b2.id }, w2.deps)), "revoked");
});

test("every lifecycle step writes an event to BOTH logs", async () => {
  const w = world();
  const b = await liveView(w);
  await readView(b.id, { chain: alexP }, w.deps);
  await revokeBridge({ chain: alexH, bridgeId: b.id }, w.deps);
  const types = (/** @type {string} */ s) => w.logs[s].map(e => e.type);
  for (const s of ["harlow", "alex"]) assert.deepEqual(types(s), ["view.proposed", "view.accepted", "view.read", "view.revoked"], s);
  assert.equal(w.logs.harlow[2].payload.side, "source");
  assert.equal(w.logs.alex[2].payload.side, "destination");
  assert.ok(!JSON.stringify(w.logs).includes("jane@example.com"), "logs carry no values");
});

// ------------------------------------------------------------------ shared views

test("view: allow-list default deny, redaction ceiling, sealed excluded", async () => {
  const w = world();
  const b = await liveView(w);
  const r = await readView(b.id, { chain: alexP }, w.deps);
  assert.deepEqual(r.fields, ["name", "status"]); // email is pii (above internal), ssn is sealed
  for (const row of r.rows) assert.deepEqual(Object.keys(row.data).sort(), ["name", "status"]);
  assert.ok(!sealedAnywhere(r));
  assert.ok(!JSON.stringify(r).includes("jane@example.com"));
  assert.ok(!("note" in r.rows[0].data) && !("tier" in r.rows[0].data), "unlisted fields never cross");
  assert.equal(await code(proposeView(viewInput({ fields: [] }), w.deps)), "bad_input");
  assert.equal(await code(proposeView(viewInput({ fields: undefined }), w.deps)), "bad_input");
});

test("view: unknown field class defaults to pii and stays out under an internal ceiling", async () => {
  const w = world();
  w.deps.schema = async () => ({ fields: { name: { red: "public", kind: "text" } } });
  const b = await liveView(w, { fields: ["name", "mystery"] });
  const r = await readView(b.id, { chain: alexP }, w.deps);
  assert.deepEqual(r.fields, ["name"]);
});

test("view: class ceiling above internal needs the owner's confirmation; privileged and secret never", async () => {
  const w = world();
  assert.equal(await code(proposeView(viewInput({ max_red: "pii" }), w.deps)), "forbidden");
  const b = await liveView(w, { max_red: "pii", owner_confirmed: true });
  const r = await readView(b.id, { chain: alexP }, w.deps);
  assert.deepEqual(r.fields, ["email", "name", "status"]);
  assert.equal(r.labels.red, "pii");
  for (const c of ["privileged", "secret"]) assert.equal(await code(proposeView(viewInput({ max_red: c, owner_confirmed: true }), w.deps)), "bad_input");
  assert.equal(await code(proposeView(viewInput({ max_red: "nope" }), w.deps)), "bad_input");
});

test("view: a sealed placeholder only when the owner confirms, and never the ref or hint", async () => {
  const w = world();
  assert.equal(await code(proposeView(viewInput({ sealed_placeholder: true }), w.deps)), "forbidden");
  const b = await liveView(w, { sealed_placeholder: true, owner_confirmed: true });
  const r = await readView(b.id, { chain: alexP }, w.deps);
  assert.deepEqual(r.rows[0].data.ssn, { sealed: "us-ssn", present: true, valid_format: true });
  assert.ok(!sealedAnywhere(r));
});

test("view: arrives labelled external, read-only, carrying the source's residency", async () => {
  const w = world();
  const b = await liveView(w);
  const r = await readView(b.id, { chain: alexP }, w.deps);
  assert.equal(r.labels.trust, "external");
  assert.deepEqual(r.labels.source_spaces, ["harlow"]);
  assert.equal(r.read_only, true);
  assert.deepEqual(r.residency.inference, ["anthropic"]);
  assert.equal(inferenceAllowed(r.residency, "anthropic"), true);
  assert.equal(inferenceAllowed(r.residency, "openai"), false);
  w.policies.harlow = { inference: "space_only", secrets: "space_only" };
  const r2 = await readView(b.id, { chain: alexP }, w.deps);
  assert.equal(inferenceAllowed(r2.residency, "anthropic"), false, "space_only refuses every model");
  w.policies.harlow = undefined;
  assert.equal(inferenceAllowed((await readView(b.id, { chain: alexP }, w.deps)).residency, "anthropic"), false, "a missing policy fails closed");
});

test("view: the destination cannot filter or sort by a field it may not read, and cannot widen the view filter", async () => {
  const w = world();
  const b = await liveView(w, { filter: { field: "status", op: "eq", value: "open" } });
  for (const field of ["email", "ssn", "note", "tier"]) {
    assert.equal(await code(readView(b.id, { chain: alexP, filter: { field, op: "eq", value: "x" } }, w.deps)), "bad_input", field);
    assert.equal(await code(readView(b.id, { chain: alexP, sort: [{ field, dir: "asc" }] }, w.deps)), "bad_input", field);
  }
  const r = await readView(b.id, { chain: alexP, filter: { field: "status", op: "eq", value: "closed" } }, w.deps);
  assert.equal(r.rows.length, 0, "the view's own filter still applies");
  const q = w.queries.at(-1);
  assert.deepEqual(q.spec.filter.and[0], { field: "status", op: "eq", value: "open" });
});

test("view: wrong space and unauthorized reads are refused; validation hooks and limits run", async () => {
  const w = world();
  const b = await liveView(w);
  assert.equal(await code(readView(b.id, { chain: alexH }, w.deps)), "wrong_space");
  assert.equal(await code(readView("br_nope", { chain: alexP }, w.deps)), "not_found");
  w.denied.add("views.read");
  assert.equal(await code(readView(b.id, { chain: alexP }, w.deps)), "forbidden");
  w.denied.delete("views.read");
  w.deps.validateInbound = async () => ({ ok: false, errors: ["bad"] });
  assert.equal(await code(readView(b.id, { chain: alexP }, w.deps)), "bad_input");
  w.deps.validateInbound = undefined; w.deps.limits = { max_rows: 1 };
  assert.equal(await code(readView(b.id, { chain: alexP }, w.deps)), "bad_input");
});

test("view: destination cache is off unless the share asks for it", async () => {
  const w = world();
  const b = await liveView(w);
  assert.equal((await readView(b.id, { chain: alexP }, w.deps)).cacheable, false);
  const c = await liveView(w, { destination_cache: true });
  assert.equal((await readView(c.id, { chain: alexP }, w.deps)).cacheable, true);
});

// ------------------------------------------------------------------ references

async function liveRef(w, over = {}) {
  const i = { chain: alexH, source: "harlow", destination: "alex", types: ["contact"], label_fields: ["name"], max_red: "public", expires_at: T0 + 24 * HOUR, ...over };
  const b = await proposeReference({ ...i, presence: proof(proposalHash("reference", i)) }, w.deps);
  await acceptBridge({ chain: alexP, bridgeId: b.id }, w.deps);
  return b;
}

test("reference: resolves with a label the grant allows and labels it external", async () => {
  const w = world();
  const b = await liveRef(w);
  const r = await resolveReference("vyre://harlow/contact/c1", { chain: alexP }, w.deps);
  assert.equal(r.resolved, true); assert.equal(r.type, "contact"); assert.equal(r.label, "Jane Doe");
  assert.equal(r.labels.trust, "external"); assert.equal(r.grant, b.id);
  assert.ok(w.logs.harlow.some(e => e.type === "reference.resolved") && w.logs.alex.some(e => e.type === "reference.resolved"));
});

test("reference: NO existence oracle. No grant, missing record, wrong type, revoked and expired all look identical", async () => {
  const w = world();
  const noGrantExisting = await resolveReference("vyre://harlow/contact/c1", { chain: alexP }, w.deps);
  const noGrantMissing = await resolveReference("vyre://harlow/contact/zzzz", { chain: alexP }, w.deps);
  const blank = (/** @type {any} */ x) => ({ ...x, urn: "" });
  assert.deepEqual(blank(noGrantExisting), blank(noGrantMissing));
  assert.equal(noGrantExisting.resolved, false); assert.equal(noGrantExisting.type, null); assert.equal(noGrantExisting.label, null);
  const b = await liveRef(w);
  const missing = await resolveReference("vyre://harlow/contact/zzzz", { chain: alexP }, w.deps);
  const wrongType = await resolveReference("vyre://harlow/matter/c1", { chain: alexP }, w.deps);
  assert.deepEqual(blank(missing), blank(noGrantMissing));
  assert.deepEqual(blank(wrongType), blank(noGrantMissing));
  // an authorize denial is the same chip too
  w.denied.add("references.resolve");
  assert.deepEqual(await resolveReference("vyre://harlow/contact/c1", { chain: alexP }, w.deps), noGrantExisting);
  w.denied.clear();
  await revokeBridge({ chain: alexH, bridgeId: b.id }, w.deps);
  assert.deepEqual(await resolveReference("vyre://harlow/contact/c1", { chain: alexP }, w.deps), noGrantExisting);
  const w2 = world();
  await liveRef(w2, { expires_at: T0 + HOUR }); w2.advance(HOUR + 1);
  assert.deepEqual(await resolveReference("vyre://harlow/contact/c1", { chain: alexP }, w2.deps), noGrantExisting);
  // a third Space with no grant
  const w3 = world(); await liveRef(w3);
  assert.deepEqual(await resolveReference("vyre://harlow/contact/c1", { chain: chain("northwind") }, w3.deps), noGrantExisting);
});

test("reference: label only from allowed fields and ceiling; sealed never; no label means null label", async () => {
  const w = world();
  await liveRef(w, { label_fields: ["email"] }); // pii above the public ceiling
  let r = await resolveReference("vyre://harlow/contact/c1", { chain: alexP }, w.deps);
  assert.equal(r.resolved, true); assert.equal(r.label, null); assert.equal(r.cacheable, false);
  const w2 = world();
  await liveRef(w2, { label_fields: ["ssn"] });
  r = await resolveReference("vyre://harlow/contact/c1", { chain: alexP }, w2.deps);
  assert.equal(r.label, null);
  assert.ok(!sealedAnywhere(r));
});

test("reference: cacheable only if the grant allows it, and the cache is wiped on revoke or on demand", async () => {
  const w = world();
  const noCache = await liveRef(w);
  assert.equal((await resolveReference("vyre://harlow/contact/c1", { chain: alexP }, w.deps)).cacheable, false);
  assert.equal(w.deps.refCache.size, 0);
  const w2 = world();
  const b = await liveRef(w2, { cache_label: true });
  const r = await resolveReference("vyre://harlow/contact/c1", { chain: alexP }, w2.deps);
  assert.equal(r.cacheable, true);
  assert.equal(w2.deps.refCache.get("vyre://harlow/contact/c1").label, "Jane Doe");
  assert.equal(wipeCacheFor(b.id, w2.deps), 1);
  assert.equal(w2.deps.refCache.size, 0);
  await resolveReference("vyre://harlow/contact/c1", { chain: alexP }, w2.deps);
  await revokeBridge({ chain: alexP, bridgeId: b.id }, w2.deps);
  assert.equal(w2.deps.refCache.size, 0, "revoke wipes the cache");
  assert.equal(noCache.spec.cache_label, false);
});

test("reference: same-Space references resolve under that Space's own read; malformed URNs throw", async () => {
  const w = world();
  const r = await resolveReference("vyre://harlow/contact/c1", { chain: alexH }, w.deps);
  assert.equal(r.resolved, true); assert.equal(r.labels.trust, "member"); assert.equal(r.cacheable, false);
  await assert.rejects(resolveReference("nonsense", { chain: alexH }, w.deps), (/** @type {any} */ e) => e.code === "bad_input");
});

// ------------------------------------------------------------------ copy

const copyInput = (/** @type {any} */ over = {}) => ({ sourceChain: alexH, destChain: alexP, urn: "vyre://harlow/contact/c1", ...over });

test("copy: its own action, new record with provenance, no live link, inherits class and residency", async () => {
  const w = world();
  const r = await copyRecord(copyInput(), w.deps);
  const c = w.created.find(x => x.s === "alex" && x.type === "contact");
  assert.ok(c); assert.equal(c.id, r.id);
  assert.deepEqual(Object.keys(r.provenance).sort(), ["at", "by", "from", "source_policy", "source_version"]);
  assert.equal(r.provenance.from, "vyre://harlow/contact/c1");
  assert.equal(r.provenance.source_version, 3);
  assert.equal(r.provenance.by, "person:alex@alex");
  assert.equal(r.provenance.at, T0);
  assert.deepEqual(r.provenance.source_policy.inference, ["anthropic"]);
  assert.equal(c.meta.live_link, false);
  assert.equal(r.red, "pii", "inherits the strongest class copied");
  assert.deepEqual(r.residency, r.provenance.source_policy);
  assert.equal(c.data.name, "Jane Doe");
  assert.ok(w.logs.harlow.some(e => e.type === "record.copied") && w.logs.alex.some(e => e.type === "record.copied"));
});

test("copy: sealed fields are never copied: empty plus a note", async () => {
  const w = world();
  const r = await copyRecord(copyInput(), w.deps);
  const c = w.created.find(x => x.s === "alex" && x.type === "contact");
  assert.equal(c.data.ssn, null);
  assert.deepEqual(r.notes, [{ field: "ssn", note: "sealed value not copied" }]);
  assert.ok(!sealedAnywhere(c));
});

test("copy: read does not imply copy; copy is separate from read", async () => {
  const w = world();
  w.denied.add("records.copy");
  assert.equal(await code(copyRecord(copyInput(), w.deps)), "forbidden");
  assert.equal(w.created.length, 0);
  w.denied.clear(); w.denied.add("records.read");
  assert.equal(await code(copyRecord(copyInput(), w.deps)), "not_found", "no read looks like absence");
  w.denied.clear();
  assert.equal(await code(copyRecord(copyInput({ urn: "vyre://harlow/contact/nope" }), w.deps)), "not_found");
});

test("copy: wrong space, same space, bad urn", async () => {
  const w = world();
  assert.equal(await code(copyRecord(copyInput({ sourceChain: alexP }), w.deps)), "wrong_space");
  assert.equal(await code(copyRecord(copyInput({ destChain: alexH }), w.deps)), "wrong_space");
  assert.equal(await code(copyRecord(copyInput({ urn: "bad" }), w.deps)), "bad_input");
  w.denied.add("records.create");
  assert.equal(await code(copyRecord(copyInput(), w.deps)), "forbidden");
});

import { createHash } from "node:crypto";
const canon = (/** @type {any} */ v) => { const s = (/** @type {any} */ x) => Array.isArray(x) ? "[" + x.map(s).join(",") + "]" : x && typeof x === "object" ? "{" + Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => JSON.stringify(k) + ":" + s(x[k])).join(",") + "}" : JSON.stringify(x === undefined ? null : x); return createHash("sha256").update(s(v)).digest().toString("base64url"); };
const sealedProof = (/** @type {any} */ over = {}) => proof(canon({ act: "copy.sealed", urn: "vyre://harlow/contact/c1", destination: "alex", fields: ["ssn"] }), over);

test("copy.sealed: needs a grant, presence, and exactly one person; a model chain always refuses", async () => {
  const w = world();
  const ok = await copyRecord(copyInput({ copy_sealed: ["ssn"], presence: sealedProof() }), w.deps);
  assert.equal(ok.red, "privileged");
  const c = w.created.find(x => x.s === "alex" && x.type === "contact");
  assert.equal(c.data.ssn.ref, "vault:alex:new", "the vault made a new sealed ref in the destination");
  assert.equal(c.data.ssn.ref === "vault:abc", false);
  // model in either chain
  for (const [s, d] of [[modelH, alexP], [alexH, modelP], [modelH, modelP]]) {
    const w2 = world();
    assert.equal(await code(copyRecord(copyInput({ sourceChain: s, destChain: d, copy_sealed: ["ssn"], presence: sealedProof() }), w2.deps)), "sealed");
    assert.equal(w2.created.length, 0);
  }
  // a service in the chain
  assert.equal(await code(copyRecord(copyInput({ sourceChain: chain("harlow", ["person", "alex"], ["service", "email"]), copy_sealed: ["ssn"], presence: sealedProof() }), world().deps)), "sealed");
  // no presence, wrong presence
  assert.equal(await code(copyRecord(copyInput({ copy_sealed: ["ssn"] }), world().deps)), "needs_presence");
  assert.equal(await code(copyRecord(copyInput({ copy_sealed: ["ssn"], presence: proof("other") }), world().deps)), "needs_presence");
  // no copy.sealed grant
  const w3 = world(); w3.denied.add("copy.sealed");
  assert.equal(await code(copyRecord(copyInput({ copy_sealed: ["ssn"], presence: sealedProof() }), w3.deps)), "forbidden");
  assert.equal(w3.created.length, 0);
  assert.equal(chainIsExactlyOnePerson(alexH), true); assert.equal(chainIsExactlyOnePerson(modelH), false);
});

// ------------------------------------------------------------------ projections

async function liveProjection(w, over = {}) {
  const i = { chain: alexH, source: "harlow", destination: "alex", types: ["case.opened"], fields: ["stage", "amount"], max_red: "internal", expires_at: T0 + 24 * HOUR, ...over };
  const b = await proposeProjection({ ...i, presence: proof(proposalHash("projection", i)) }, w.deps);
  await acceptBridge({ chain: alexP, bridgeId: b.id }, w.deps);
  return b;
}
const EV = { id: "ev_origin_77", seq: 1042, space: "harlow", type: "case.opened", subject: "vyre://harlow/contact/c1", cause: "ev_origin_70", data: { stage: "intake", amount: 5, note: "free text" } };
const projSchema = { fields: { stage: { red: "internal", kind: "choice" }, amount: { red: "internal", kind: "number" }, note: { red: "pii", kind: "text" } } };

test("projection: free text needs the owner's confirmation at proposal; unconfirmed free text is dropped", async () => {
  const w = world(); w.deps.schema = async () => projSchema;
  const i = { chain: alexH, source: "harlow", destination: "alex", types: ["case.opened"], fields: ["stage", "note"], max_red: "pii", owner_confirmed: true, expires_at: T0 + HOUR };
  assert.equal(await code(proposeProjection({ ...i, presence: proof(proposalHash("projection", i)) }, w.deps)), "forbidden");
  const b = await liveProjection(w, { fields: ["stage", "amount"] });
  const row = await projectEvent({ projectionId: b.id, event: EV }, w.deps);
  assert.deepEqual(Object.keys(row.data).sort(), ["amount", "stage"]);
  const j = { ...i, free_text_confirmed: true };
  const b2 = await proposeProjection({ ...j, presence: proof(proposalHash("projection", j)) }, w.deps);
  assert.equal(b2.spec.free_text_confirmed, true);
  const w3 = world(); w3.deps.schema = async () => projSchema;
  const k = { chain: alexH, source: "harlow", destination: "alex", types: ["case.opened"], fields: ["stage", "note"], max_red: "pii", owner_confirmed: true, free_text_confirmed: true, expires_at: T0 + HOUR };
  const b3 = await proposeProjection({ ...k, presence: proof(proposalHash("projection", k)) }, w3.deps);
  await acceptBridge({ chain: alexP, bridgeId: b3.id }, w3.deps);
  const row3 = await projectEvent({ projectionId: b3.id, event: EV }, w3.deps);
  assert.equal(row3.data.note, "free text");
});

test("projection: allow-list and class ceiling enforced here; ids are projection-scoped and origin ordering is hidden", async () => {
  const w = world(); w.deps.schema = async () => projSchema;
  const b = await liveProjection(w, { fields: ["stage", "amount"], max_red: "internal" });
  const row = await projectEvent({ projectionId: b.id, event: { ...EV, data: { ...EV.data, extra: "x", ssn: SSN } } }, w.deps);
  assert.deepEqual(Object.keys(row.data).sort(), ["amount", "stage"]);
  const text = JSON.stringify([row, w.created, w.logs]);
  for (const secret of ["ev_origin_77", "ev_origin_70", "1042", "c1", "vault:"]) assert.ok(!text.includes(secret), "leaked " + secret);
  assert.match(row.id, /^px_/); assert.equal(row.trust, "external"); assert.deepEqual(row.source_spaces, ["harlow"]);
  assert.match(row.subject, /^vyre:\/\/harlow\/contact\/px_/);
  const row2 = await projectEvent({ projectionId: b.id, event: { ...EV, id: "ev_origin_78", seq: 1043 } }, w.deps);
  assert.notEqual(row.id, row2.id); assert.equal(row.seq, 1); assert.equal(row2.seq, 2);
  // deterministic for the same event
  assert.equal(scopedAgain(w, b, "ev_origin_77"), row.id);
  assert.ok(w.logs.harlow.some(e => e.type === "projection.delivered") && w.logs.alex.some(e => e.type === "projection.delivered"));
});
function scopedAgain(/** @type {any} */ w, /** @type {any} */ b, /** @type {string} */ id) {
  return "px_" + createHash("sha256").update(`${b.salt}:${id}`).digest("hex").slice(0, 24);
}

test("projection: selector, not accepted, wrong space, expiry, revoke", async () => {
  const w = world(); w.deps.schema = async () => projSchema;
  const i = { chain: alexH, source: "harlow", destination: "alex", types: ["case.opened"], fields: ["stage"], max_red: "internal", subject_prefix: "vyre://harlow/contact/", expires_at: T0 + HOUR };
  const b = await proposeProjection({ ...i, presence: proof(proposalHash("projection", i)) }, w.deps);
  assert.equal(await code(projectEvent({ projectionId: b.id, event: EV }, w.deps)), "not_accepted");
  await acceptBridge({ chain: alexP, bridgeId: b.id }, w.deps);
  assert.equal(await projectEvent({ projectionId: b.id, event: { ...EV, type: "other.thing" } }, w.deps), null);
  assert.equal(await projectEvent({ projectionId: b.id, event: { ...EV, subject: "vyre://harlow/matter/m1" } }, w.deps), null);
  assert.equal(await code(projectEvent({ projectionId: b.id, event: { ...EV, space: "alex" } }, w.deps)), "wrong_space");
  w.advance(2 * HOUR);
  assert.equal(await code(projectEvent({ projectionId: b.id, event: EV }, w.deps)), "expired");
  const w2 = world(); w2.deps.schema = async () => projSchema;
  const b2 = await liveProjection(w2);
  await revokeBridge({ chain: alexH, bridgeId: b2.id }, w2.deps);
  assert.equal(await code(projectEvent({ projectionId: b2.id, event: EV }, w2.deps)), "revoked");
});

// ------------------------------------------------------------------ kits

const KIT = { name: "Northwind Bakery starter", version: "1.0.0", types: [{ name: "order", label: "Order", fields: [{ name: "customer", kind: "text", label: "Customer" }, { name: "total", kind: "money", label: "Total" }], stages: [{ name: "Baking" }, { name: "Ready" }] }], flows: [{ name: "Order ready", steps: [] }] };

test("kit: exports definitions and strips runtime keys", () => {
  const k = kitExport({ ...KIT, space: "harlow", created_at: 5 });
  assert.equal(k.format, "vyre-kit"); assert.ok(!("space" in k) && !("created_at" in k));
  assert.equal(k.types[0].name, "order");
});

test("kit: refuses records, ids, urns, sealed values and unknown sections", () => {
  const bad = (/** @type {any} */ x) => assert.throws(() => kitExport({ ...KIT, ...x }), (/** @type {any} */ e) => e.code === "bad_input");
  bad({ records: [{ id: "c1" }] });
  bad({ rows: [] });
  bad({ types: [{ ...KIT.types[0], rows: [{ a: 1 }] }] });
  bad({ views: [{ name: "v", target: "vyre://harlow/contact/c1" }] });
  bad({ flows: [{ name: "f", note: "for 0190c6f2-aaaa-4bbb-8ccc-123456789012" }] });
  bad({ description: "ssn 123-45-6789" });
  bad({ description: "card 4242 4242 4242 4242" });
  bad({ types: [{ ...KIT.types[0], seed: SSN, sealed: "x", ref: "r" }] });
  bad({ secrets: { a: 1 } });
  assert.throws(() => kitExport(/** @type {any} */ (null)), /object/);
  assert.throws(() => kitExport({ types: [] }), /name/);
});

test("kit: seed data only inside a clearly labelled sample section, with no ids or sealed values", () => {
  const sample = { label: "sample", is_sample: true, records: [{ type: "order", data: { customer: "Pat Example", total: { amount: 12, currency: "USD" } } }] };
  assert.equal(kitExport({ ...KIT, sample }).sample.records.length, 1);
  assert.throws(() => kitExport({ ...KIT, sample: { records: sample.records } }), (/** @type {any} */ e) => e.code === "bad_input");
  assert.throws(() => kitExport({ ...KIT, sample: { ...sample, records: [{ type: "order", id: "o1", data: {} }] } }), (/** @type {any} */ e) => e.code === "bad_input");
  assert.throws(() => kitExport({ ...KIT, sample: { ...sample, records: [{ type: "order", data: { ssn: SSN } }] } }), (/** @type {any} */ e) => e.code === "bad_input");
  assert.throws(() => kitExport({ ...KIT, sample: { ...sample, records: [{ type: "order", data: { c: "123-45-6789" } }] } }), (/** @type {any} */ e) => e.code === "bad_input");
  assert.throws(() => kitExport({ ...KIT, sample: { ...sample, records: [{ type: "order", data: { c: "vyre://harlow/contact/c1" } }] } }), (/** @type {any} */ e) => e.code === "bad_input");
});

test("kit: the install plan lists everything it would add and is never automatic", () => {
  const kit = kitExport({ ...KIT, sample: { label: "sample", is_sample: true, records: [{ type: "order", data: { customer: "Pat" } }] } });
  const plan = kitInstallPlan(kit, { types: [], flows: [] });
  assert.equal(plan.automatic, false); assert.equal(plan.ask.grant_to, "installer");
  assert.deepEqual(plan.adds.types, [{ name: "order", fields: ["customer", "total"], stages: ["Baking", "Ready"] }]);
  assert.deepEqual(plan.adds.flows, ["Order ready"]);
  assert.equal(plan.sample_records, 1);
  assert.ok(plan.ask.lines.some(l => /sample/.test(l)));
  const plan2 = kitInstallPlan(kit, { types: [{ name: "order", fields: [{ name: "customer" }], stages: [{ name: "Baking" }] }], flows: [{ name: "Order ready" }] });
  assert.deepEqual(plan2.adds.types, []); assert.deepEqual(plan2.adds.fields, [{ type: "order", field: "total" }]); assert.deepEqual(plan2.adds.stages, [{ type: "order", stage: "Ready" }]); assert.deepEqual(plan2.adds.flows, []);
  assert.notEqual(plan.plan_hash, plan2.plan_hash);
  assert.throws(() => kitInstallPlan({ name: "x" }, {}), /not a Kit/);
});

test("kit: installing needs the approval of exactly this plan, and a grant", async () => {
  const w = world(); const defined = /** @type {any[]} */ ([]);
  const base = w.deps.records;
  w.deps.records = (/** @type {string} */ s) => ({ ...base(s), define: async (/** @type {any} */ d) => { defined.push(d); return { applied: true, changes: [] }; } });
  w.deps.installedState = async () => ({ types: [], flows: [] });
  const kit = kitExport(KIT);
  const plan = kitInstallPlan(kit, { types: [], flows: [] });
  const c = chain("alex");
  assert.equal(await code(installKit({ chain: c, kit, approved_plan_hash: "stale" }, w.deps)), "not_accepted");
  assert.equal(defined.length, 0);
  w.denied.add("kits.install");
  assert.equal(await code(installKit({ chain: c, kit, approved_plan_hash: plan.plan_hash }, w.deps)), "forbidden");
  w.denied.clear();
  const r = await installKit({ chain: c, kit, approved_plan_hash: plan.plan_hash }, w.deps);
  assert.equal(r.plan.total, 2); assert.equal(defined[0].add_types[0].name, "order");
  assert.ok(w.logs.alex.some(e => e.type === "kit.installed"));
});

// ------------------------------------------------------------------ continue in another space

test("continue: creates a task in the destination that carries references, not copies", async () => {
  const w = world();
  const r = await continueIn({ fromSpace: "harlow", toSpace: "alex", by: alexH, summaryRefs: ["vyre://harlow/contact/c1", "vyre://harlow/matter/m1"], title: "Follow up" }, w.deps);
  assert.equal(r.task.source, "continue_in_space"); assert.equal(r.task.space, "alex");
  assert.deepEqual(r.task.inputs, ["vyre://harlow/contact/c1", "vyre://harlow/matter/m1"]);
  assert.ok(!JSON.stringify(r.task).includes("Jane Doe"));
  assert.ok(w.logs.harlow.some(e => e.type === "task.continued") && w.logs.alex.some(e => e.type === "task.continued"));
});

test("continue: refuses wrong space, same space, no refs, non-URN text, refs from another Space, no authorization", async () => {
  const w = world();
  const base = { fromSpace: "harlow", toSpace: "alex", by: alexH, summaryRefs: ["vyre://harlow/contact/c1"] };
  assert.equal(await code(continueIn({ ...base, by: alexP }, w.deps)), "wrong_space");
  assert.equal(await code(continueIn({ ...base, toSpace: "harlow" }, w.deps)), "bad_input");
  assert.equal(await code(continueIn({ ...base, summaryRefs: [] }, w.deps)), "bad_input");
  assert.equal(await code(continueIn({ ...base, summaryRefs: ["Jane Doe called about the bakery"] }, w.deps)), "bad_input");
  assert.equal(await code(continueIn({ ...base, summaryRefs: ["vyre://alex/note/n1"] }, w.deps)), "bad_input");
  w.denied.add("tasks.continue");
  assert.equal(await code(continueIn(base, w.deps)), "forbidden");
  assert.equal(w.tasks.length, 0);
});

// ------------------------------------------------------------------ multi-Space sessions

test("session: the set of source Spaces, drafts only, Ask naming both Spaces", () => {
  const p = sessionPolicy(["harlow", "alex", "harlow"]);
  assert.equal(p.multi, true); assert.deepEqual(p.source_spaces, ["alex", "harlow"]); assert.equal(p.persistent_writes, "drafts");
  assert.throws(() => checkSessionWrite(p, { persistent: true }), (/** @type {any} */ e) => e.code === "forbidden");
  assert.throws(() => checkSessionWrite(p, { persistent: true, draft: false }), (/** @type {any} */ e) => e.code === "forbidden");
  assert.equal(checkSessionWrite(p, { persistent: true, draft: true }), true);
  assert.equal(checkSessionWrite(p, { persistent: false }), true);
  for (const risk of ["outward.send", "outward.share", "outward.pay", "grant"]) {
    assert.throws(() => checkSessionAct(p, { risk }), (/** @type {any} */ e) => e.code === "not_accepted", risk);
    assert.throws(() => checkSessionAct(p, { risk, ask: { spaces: ["harlow"] } }), (/** @type {any} */ e) => e.code === "not_accepted", risk);
    assert.equal(checkSessionAct(p, { risk, ask: { spaces: ["harlow", "alex"] } }), true);
  }
  assert.equal(checkSessionAct(p, { risk: "read" }), true);
  assert.equal(checkSessionAct(p, { risk: "write" }), true);
  assert.throws(() => checkSessionAct(p, { risk: "weird" }), (/** @type {any} */ e) => e.code === "bad_input");
  const one = sessionPolicy(["alex"]);
  assert.equal(one.multi, false); assert.equal(one.persistent_writes, "direct"); assert.equal(checkSessionWrite(one, { persistent: true }), true);
  assert.throws(() => sessionPolicy([]), (/** @type {any} */ e) => e.code === "bad_input");
});

test("session: the strictest residency wins across Spaces", () => {
  const harlow = { space: "harlow", residency: { inference: ["anthropic", "local"], secrets: "space_only" } };
  const alex = { space: "alex", residency: { inference: "any", secrets: "any" } };
  const p = sessionPolicy([harlow, alex]);
  assert.deepEqual(p.residency.inference, ["anthropic", "local"]);
  assert.equal(checkSessionProvider(p, "anthropic"), true);
  assert.throws(() => checkSessionProvider(p, "openai"), (/** @type {any} */ e) => e.code === "forbidden");
  const spaceOnly = sessionPolicy([{ space: "harlow", residency: { inference: "space_only" } }, alex]);
  assert.throws(() => checkSessionProvider(spaceOnly, "anthropic"), (/** @type {any} */ e) => e.code === "forbidden");
  assert.equal(spaceOnly.residency.secrets, "space_only");
  const disjoint = sessionPolicy([{ space: "a", residency: { inference: ["x"] } }, { space: "b", residency: { inference: ["y"] } }]);
  assert.throws(() => checkSessionProvider(disjoint, "x"), (/** @type {any} */ e) => e.code === "forbidden");
  assert.equal(sessionPolicy([{ space: "a" }, alex]).residency.inference, "space_only", "a Space with no policy fails closed");
  assert.deepEqual(strictestResidency([{ inference: ["a", "b"] }, { inference: ["b", "c"] }]).inference, ["b"]);
  assert.deepEqual(normalizeResidency(undefined), { inference: "space_only", secrets: "space_only" });
});

test("session: derived output carries every source label; cross-Space paste is refused", () => {
  const a = { labels: { trust: "member", red: "internal", source_spaces: ["alex"] } };
  const h = { labels: { trust: "external", red: "pii", source_spaces: ["harlow"] } };
  const d = deriveLabels([a, h]);
  assert.deepEqual(d, { trust: "external", red: "pii", source_spaces: ["alex", "harlow"] });
  assert.equal(assertNoCrossSpacePaste({ labels: d }, [a, h]), true);
  assert.throws(() => assertNoCrossSpacePaste({ labels: { source_spaces: ["alex"] } }, [a, h]), (/** @type {any} */ e) => e.code === "forbidden" && e.details.missing[0] === "harlow");
  assert.throws(() => assertNoCrossSpacePaste({}, [a, h]), (/** @type {any} */ e) => e.code === "forbidden");
  assert.equal(assertNoForeignContent({ source_spaces: ["alex"] }, "alex"), true);
  assert.throws(() => assertNoForeignContent(d, "alex"), (/** @type {any} */ e) => e.code === "forbidden", "a Harlow fact cannot go into the personal Space without a card");
  assert.deepEqual(deriveLabels([]), { trust: "system", red: "public", source_spaces: [] });
});
