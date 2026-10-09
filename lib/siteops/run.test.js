// @ts-check
// run and heal: one call, one send; writes held and never retried; a changed site repaired only when the repair is proven.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { learnOperation } from "./learn.js";
import { runOperation } from "./run.js";
import { healOperation } from "./heal.js";
import { buildRequest } from "./build.js";
import { getAt } from "./codec.js";
import * as F from "./fixtures.js";

const cookies = [{ name: "sid", value: F.SECRET_COOKIE }];
const trigger = { url: "https://app.example.com/search?q={query}" };
const json = (/** @type {any} */ b, status = 200) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const people = (/** @type {string} */ t, key = "results") => ({ total: 1, [key]: [{ id: "p-1", name: `${t} one`, profileUrl: "https://x/in/1", headline: "H", meta: { score: 1, tags: [] } }] });

const rest = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies, storage: F.restStorage, trigger }).operation;
const refs = (/** @type {Record<string,string>} */ m) => (/** @type {string} */ r) => m[r];

test("a read: refs resolved, one send, the answer classified, extracted and returned without headers or cookies", async () => {
  const op = rest();
  const sent = [];
  const r = await runOperation(op, { query: "gamma labs" }, { resolveRef: refs({ "session:csrf": F.CSRF }), send: async req => { sent.push(req); return json(people("gamma labs")); } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers["x-csrf-token"], F.CSRF);
  assert.equal(r.ok, true);
  assert.equal(/** @type {any} */ (r.data)[0].name, "gamma labs one");
  assert.ok(!JSON.stringify(r).includes(F.CSRF), "the credential is not in the result");
  assert.equal(r.executed, false);
});

test("a bad input never reaches the network; a missing ref is reported", async () => {
  const op = rest();
  let calls = 0;
  const r = await runOperation(op, {}, { send: async () => { calls++; return json({}); } });
  assert.equal(r.class, "input"); assert.equal(calls, 0);
  const m = await runOperation(op, { query: "gamma labs" }, { send: async () => json(people("x"), 401) });
  assert.deepEqual(m.missingRefs, ["session:csrf"]);
  assert.equal(m.class, "auth");
  assert.match(String(m.next), /sign in again/);
});

test("a write is held by the gate and never sent; once let through it is sent exactly once, and an ambiguous failure is not retried", async () => {
  const send = learnOperation({ name: "sendMessage", kind: "send", exchanges: F.pageSend("ada-lovelace", "hello there friend"), exchanges2: F.pageSend("grace-hopper", "second text here"),
    examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies, storage: F.restStorage, trigger: { url: "https://app.example.com/inbox" } }).operation;
  let sends = 0;
  const base = { resolveRef: refs({ "session:csrf": F.CSRF }), send: async () => { sends++; return json({ ok: true, id: "m1" }, 201); } };
  const held = await runOperation(send, { recipient: "alan-turing", text: "a fresh note" }, { ...base, gate: () => ({ held: true, why: "waits" }) });
  assert.equal(held.class, "held"); assert.equal(sends, 0);
  const done = await runOperation(send, { recipient: "alan-turing", text: "a fresh note" }, { ...base, gate: () => null });
  assert.equal(done.ok, true); assert.equal(done.executed, true); assert.equal(sends, 1);
  const lost = await runOperation(send, { recipient: "alan-turing", text: "a fresh note" }, { ...base, send: async () => { sends++; throw new Error("socket hang up"); } });
  assert.equal(lost.ok, false); assert.equal(lost.ambiguous, true); assert.equal(lost.executed, false);
  assert.match(String(lost.next), /check the site before any retry/);
  assert.equal(sends, 2, "one send per call, no automatic retry");
  const refused = await runOperation(send, { recipient: "alan-turing", text: "a fresh note" }, { ...base, send: async () => json({ error: "forbidden" }, 403) });
  assert.equal(refused.class, "blocked");
});

/** A fake GraphQL site whose persisted-query hash a deploy rotates. */
function gqlSite() {
  const state = { hash: "a".repeat(64) };
  /** @param {any} req */
  const answer = req => {
    const b = JSON.parse(req.body);
    if (b.extensions.persistedQuery.sha256Hash !== state.hash) return json({ errors: [{ message: "PersistedQueryNotFound" }], data: null });
    return json({ data: { searchPeople: { edges: people(b.variables.query).results.map(n => ({ node: n })) } } });
  };
  return { state, answer, pageFor: (/** @type {string} */ t) => F.pageGraphql(t, state.hash) };
}

test("heal: a rotated persisted-query hash is relearned from the page and kept only after a replay answers ok", async () => {
  const site = gqlSite();
  const op = learnOperation({ name: "searchGql", exchanges: site.pageFor("alpha corp"), exchanges2: site.pageFor("beta works"), examples: [{ term: "alpha corp" }, { term: "beta works" }], cookies, trigger }).operation;
  op.response.extract = "data.searchPeople.edges";
  const deps = { send: async (/** @type {any} */ req) => site.answer(req), runTrigger: async () => ({ exchanges: site.pageFor("gamma labs") }) };
  assert.equal((await runOperation(op, { term: "gamma labs" }, deps)).ok, true, "works before the deploy");
  site.state.hash = "c".repeat(64);
  const broken = await runOperation(op, { term: "gamma labs" }, deps);
  assert.equal(broken.class, "drift");
  const h = await healOperation(op, { term: "gamma labs" }, deps);
  assert.equal(h.outcome, "healed", JSON.stringify(h));
  assert.ok(JSON.stringify(h.operation.request).includes("c".repeat(64)), "the new hash is in the template");
  assert.equal(h.operation.match.operationName, "SearchPeople");
  assert.equal((await runOperation(h.operation, { term: "delta inc" }, deps)).ok, true, "and it works on an input nobody showed it");
  assert.deepEqual(h.operation.params, op.params, "what was named and typed stays");
});

test("heal: a moved answer is found again; a repair that does not answer is not kept; a missing request and a login wall are reported", async () => {
  // the list moved from results to items
  const op = rest();
  const moved = { send: async () => json(people("gamma labs", "items")), resolveRef: refs({ "session:csrf": F.CSRF }), runTrigger: async () => ({ exchanges: F.pageRest("gamma labs").map(e => e.id === 1 ? { ...e, response: { ...e.response, body: JSON.stringify(people("gamma labs", "items")) } } : e), cookies, storage: F.restStorage }) };
  assert.equal((await runOperation(op, { query: "gamma labs" }, moved)).class, "drift");
  const h = await healOperation(op, { query: "gamma labs" }, moved);
  assert.equal(h.outcome, "healed", JSON.stringify(h));
  assert.equal(h.operation.response.extract, "items");
  // the replay of the relearned request still fails: nothing is kept
  const stuck = await healOperation(op, { query: "gamma labs" }, { ...moved, send: async () => json({ error: "nope" }, 500) });
  assert.equal(stuck.outcome, "failed"); assert.equal(stuck.operation, undefined);
  // the trigger no longer fires the request / lands on a sign-in page
  assert.match((await healOperation(op, { query: "gamma labs" }, { ...moved, runTrigger: async () => ({ exchanges: [] }) })).reason, /fired no request matching/);
  const wall = await healOperation(op, { query: "gamma labs" }, { ...moved, runTrigger: async () => ({ exchanges: [], loginWall: "/login" }) });
  assert.equal(wall.class, "auth");
  void buildRequest; void getAt;
});
