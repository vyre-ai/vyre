// @ts-check
// learn: two examples and a diff become a named, typed operation; the operation holds no credential and no example; it replays on an input nobody showed it.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { learnOperation, matches, hashLike, checkExamples, rankCandidates, operationNameOf } from "./learn.js";
import { buildRequest, refsOf, checkInputs } from "./build.js";
import { judge } from "./classify.js";
import { getAt } from "./codec.js";
import * as F from "./fixtures.js";

const cookies = [{ name: "sid", value: F.SECRET_COOKIE }];
const trigger = { url: "https://app.example.com/search?q={query}" };
const resolver = (/** @type {Record<string, string>} */ m) => (/** @type {string} */ ref) => m[ref];

/** Everything a stored operation could leak. */
const NEVER = [F.SECRET_COOKIE, F.CSRF, "alpha corp", "beta works"];
const assertClean = (/** @type {any} */ op) => { const s = JSON.stringify(op); for (const bad of NEVER) assert.ok(!s.includes(bad), `the operation holds ${bad}`); };

function learnRest(extra = {}) {
  return learnOperation({
    name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"),
    examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies, storage: F.restStorage, trigger, now: "2026-10-09T00:00:00.000Z", ...extra,
  });
}

test("REST search: the input is a slot, the csrf header a session ref, the cookie a dropped header, and nothing secret or typed is stored", () => {
  const { operation: op, warnings } = learnRest();
  assert.equal(op.name, "searchPeople");
  assert.equal(op.kind, "read");
  assert.deepEqual(op.match, { method: "GET", host: "app.example.com", path: "/api/v2/search" });
  assert.deepEqual(op.slots.find((/** @type {any} */ s) => s.param === "query")?.at, ["query:q"]);
  assert.ok(op.slots.some((/** @type {any} */ s) => s.ref === "session:csrf" && s.at[0] === "header:x-csrf-token"));
  assert.equal(op.request.headers.cookie, undefined, "the cookie is the page's to send");
  assert.equal(op.login, true);
  assert.deepEqual(op.rungs, ["page", "box", "mac"], "a login means no plain-HTTP rung");
  assert.equal(op.minTier, 1);
  assertClean(op);
  assert.ok(warnings.every(w => !w.includes("one example")), warnings.join("; "));
  assert.deepEqual(refsOf(op), ["session:csrf"]);
});

test("replay on a third input nobody showed it: the built request carries the new value and the page's credential, and the answer is judged and picked", async t => {
  const { operation: op } = learnRest();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const ok = req.headers["x-csrf-token"] === F.CSRF && u.pathname === "/api/v2/search" && u.searchParams.get("limit") === "20";
    res.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { total: 3, results: [{ id: "p-9", name: `${u.searchParams.get("q")} one`, profileUrl: "https://x/in/g", headline: "H", meta: { score: 1, tags: [] } }] } : { error: "csrf" }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;

  const built = buildRequest(op, { query: "gamma labs" }, resolver({ "session:csrf": F.CSRF }));
  assert.equal(built.headers["x-csrf-token"], F.CSRF);
  const res = await fetch(built.url.replace("https://app.example.com", base), { headers: built.headers });
  const verdict = judge(op, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "" }, body: await res.text() });
  assert.equal(verdict.class, "ok", verdict.reason);
  assert.equal(/** @type {any} */ (verdict.data)[0].name, "gamma labs one");

  // without the credential the page would have sent, the site refuses and the classifier says why
  const bare = buildRequest(op, { query: "gamma labs" });
  assert.equal(bare.headers["x-csrf-token"], undefined, "an unresolved ref drops the header rather than sending a blank");
  const refused = await fetch(bare.url.replace("https://app.example.com", base), { headers: bare.headers });
  assert.equal(judge(op, { status: refused.status, headers: {}, body: await refused.text() }).class, "blocked");
});

test("a counter or timestamp between runs is kept constant; a signature is a nonce and needs the page itself", () => {
  const a = learnRest();
  assert.ok(a.warnings.every(w => !/nonce/.test(w)));
  const b = learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp", "sigAAAA1111bbbb"), exchanges2: F.pageRest("beta works", "sigCCCC2222dddd"),
    examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies, storage: F.restStorage, trigger });
  assert.equal(b.operation.minTier, 3);
  assert.ok(!b.operation.rungs.includes("public"));
  assert.ok(b.warnings.some(w => /nonce or signature/.test(w)), b.warnings.join("; "));
});

test("one example works but says so", () => {
  const { warnings } = learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), examples: [{ query: "alpha corp" }], cookies, storage: F.restStorage, trigger });
  assert.ok(warnings.some(w => /one example/.test(w)));
});

test("GraphQL: matched on the operation name, never the hash; the hash is a volatile anchor to relearn", () => {
  const { operation: op } = learnOperation({ name: "searchPeopleGql", exchanges: F.pageGraphql("alpha corp"), exchanges2: F.pageGraphql("beta works"),
    examples: [{ term: "alpha corp" }, { term: "beta works" }], cookies, trigger });
  assert.equal(op.match.operationName, "SearchPeople");
  assert.ok(!JSON.stringify(op.match).includes("9f3c1d7b"), "no hash in the match");
  assert.ok(op.volatile.length >= 1 && op.volatile[0].anchor === "SearchPeople", JSON.stringify(op.volatile));
  assert.deepEqual(op.slots.find((/** @type {any} */ s) => s.param === "term")?.at, ["body", "json:/variables/query"]);
  const built = buildRequest(op, { term: "gamma labs" });
  assert.equal(JSON.parse(/** @type {string} */ (built.body)).variables.query, "gamma labs");
  assert.equal(JSON.parse(/** @type {string} */ (built.body)).variables.first, 10, "a constant keeps its JSON type");
  // a rotated hash on the same operation still matches, because the match holds only the stable identity
  const rotated = F.pageGraphql("zeta", "b".repeat(64))[2];
  assert.ok(matches(op.match, rotated.request));
  assert.equal(operationNameOf(rotated.request), "SearchPeople");
  assertClean(op);
});

test("a Google-style batch: the input is reached through form, JSON and JSON-in-a-string; the per-session field is a ref", () => {
  const { operation: op } = learnOperation({ name: "batchSearch", exchanges: F.pageBatch("alpha corp"), exchanges2: F.pageBatch("beta works"),
    examples: [{ term: "alpha corp" }, { term: "beta works" }], cookies, trigger });
  const slot = op.slots.find((/** @type {any} */ s) => s.param === "term");
  assert.deepEqual(slot.at, ["form:f.req", "json:/0/0/1", "json:/0"]);
  assert.ok(op.slots.some((/** @type {any} */ s) => s.ref === "session:at" && s.at[0] === "form:at"));
  const built = buildRequest(op, { term: "gamma labs" }, resolver({ "session:at": "AT-live-value-123" }));
  assert.equal(getAt(built, ["form:f.req", "json:/0/0/1", "json:/0"]), "gamma labs");
  assert.equal(getAt(built, ["form:at"]), "AT-live-value-123");
  assert.equal(op.response.xssiPrefix, ")]}'");
});

test("a write is learned from an aborted request: kind send, inputs bound, nothing example left behind", () => {
  const { operation: op } = learnOperation({ name: "sendMessage", kind: "send", exchanges: F.pageSend("ada-lovelace", "hello there friend"), exchanges2: F.pageSend("grace-hopper", "second text here"),
    examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies, storage: F.restStorage, trigger: { url: "https://app.example.com/inbox" } });
  assert.equal(op.kind, "send");
  const s = JSON.stringify(op);
  for (const bad of ["ada-lovelace", "hello there friend", "grace-hopper", F.CSRF, F.SECRET_COOKIE]) assert.ok(!s.includes(bad), bad);
  const built = buildRequest(op, { recipient: "alan-turing", text: "a fresh note" }, resolver({ "session:csrf": F.CSRF }));
  assert.deepEqual(JSON.parse(/** @type {string} */ (built.body)), { recipient: "alan-turing", body: "a fresh note", channel: "direct" });
  assert.equal(built.method, "POST");
});

test("learning refuses examples it cannot locate, examples that are too short or alike, and inputs that fit nothing", () => {
  assert.throws(() => checkExamples({ a: "ab" }, "example"), /at least 3 characters/);
  assert.throws(() => checkExamples({ a: "same value", b: "SAME value" }, "example"), /share the value/);
  assert.throws(() => learnOperation({ name: "x", exchanges: F.pageRest("alpha corp"), examples: [{ query: "not in any request" }], trigger }), /no captured request carries the example values/);
  assert.throws(() => learnOperation({ name: "x", exchanges: F.pageRest("alpha corp"), examples: [{ query: "alpha corp", other: "zzz-nothing" }], trigger, id: 1 }), /is not in the learned request/);
});

test("candidates rank by evidence: the data request beats analytics and assets", () => {
  const ranked = rankCandidates(F.pageRest("alpha corp"), { query: "alpha corp" });
  assert.equal(ranked[0].id, 1);
  assert.deepEqual(ranked[0].hits, ["query"]);
  assert.ok(!ranked.some(c => c.id === 900 || c.id === 901), "script and beacon are noise");
});

test("inputs are checked before anything is sent", () => {
  const { operation: op } = learnRest();
  assert.throws(() => checkInputs(op, {}), /missing required input "query"/);
  assert.equal(/** @type {any} */ (null, (() => { try { checkInputs(op, {}); } catch (e) { return /** @type {any} */ (e).code; } })()), "input");
  assert.ok(hashLike("a".repeat(8) + "9f3c1d7b2e4a6c8d") && !hashLike("UserByScreenName"));
});
