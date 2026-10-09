// @ts-check
// The LinkedIn site kit's trial, on a replica of a professional network's web app (replica/professional-network.js: the real shapes, none of the real data): teach a read from TWO examples, then read
// twenty profiles nobody showed it; search; the inbox; a message that is learned by blocking it and sent once after a yes; a deploy that rotates the query hash, repaired and proven; a security
// check that stops the account. Real HTTP on a local socket, no model anywhere.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { learnOperation, matches, operationNameOf } from "./learn.js";
import { runOperation } from "./run.js";
import { healOperation } from "./heal.js";
import { buildRequest } from "./build.js";
import { resolverFor } from "./page.js";
import { suggestPick } from "./pickfields.js";
import { isChallenge } from "../../core/connectors/governor.js";
import { startReplica, profileCall, searchCall } from "./replica/professional-network.js";

/** What the page does: make each call over the socket with its cookies, and keep it as the traffic the learner reads. */
async function page(/** @type {any} */ rep, /** @type {any[]} */ calls, /** @type {number} */ firstId = 1) {
  const out = [];
  let id = firstId;
  for (const c of calls) {
    const headers = { ...c.headers, cookie: rep.session.cookie };
    const r = await fetch(c.url, { method: c.method, headers, ...(c.body ? { body: c.body } : {}) });
    const body = await r.text();
    out.push({ id: id++, resourceType: "fetch", request: { method: c.method, url: c.url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])), ...(c.body ? { body: c.body } : {}) },
      response: { status: r.status, headers: Object.fromEntries(r.headers), contentType: r.headers.get("content-type") || "", body } });
  }
  return out;
}
/** The browser that signs: the page's cookie and a real fetch. */
const deps = (/** @type {any} */ rep, /** @type {any} */ op, extra = {}) => {
  const state = { cookie: { JSESSIONID: `"${rep.session.csrf}"`, lang: "v=2" }, local: {}, session: {} };
  return { resolveRef: resolverFor(state, [], op), send: async (/** @type {any} */ req) => {
    const r = await fetch(req.url, { method: req.method, headers: { ...req.headers, cookie: rep.session.cookie }, ...(req.body ? { body: req.body } : {}) });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
  }, ...extra };
};
const cookies = (/** @type {any} */ rep) => [{ name: "JSESSIONID", value: `"${rep.session.csrf}"` }];
const fullName = (/** @type {any} */ p) => `${p.firstName} ${p.lastName}`;

async function teachProfile(/** @type {any} */ rep) {
  const [a, b] = [rep.members[0], rep.members[1]];
  const ex1 = await page(rep, [profileCall(rep.origin, a.slug, rep.session.csrf, rep.state.hash)]);
  const ex2 = await page(rep, [profileCall(rep.origin, b.slug, rep.session.csrf, rep.state.hash)], 100);
  const { operation, warnings } = learnOperation({ name: "readProfile", exchanges: ex1, exchanges2: ex2, examples: [{ slug: a.slug }, { slug: b.slug }], cookies: cookies(rep),
    trigger: { url: `${rep.origin}/in/{slug}` }, now: "2026-10-09T00:00:00.000Z" });
  return { operation, warnings, a, b, ex1 };
}

test("teach a profile read from two examples: the slug inside the RestLi parentheses is an input, the csrf is the page's cookie, and no login or example is kept", async t => {
  const rep = await startReplica(); t.after(() => rep.close());
  const { operation: op, warnings } = await teachProfile(rep);
  assert.deepEqual(op.params.map((/** @type {any} */ p) => p.name), ["slug"]);
  assert.ok(op.slots.some((/** @type {any} */ s) => s.param === "slug" && s.at[0] === "query:variables" && s.template && /vanityName:\{slug\}/.test(s.template)), JSON.stringify(op.slots));
  const csrf = op.slots.find((/** @type {any} */ s) => s.ref === "cookie:JSESSIONID");
  assert.ok(csrf && csrf.transform === "strip-quotes" && csrf.at[0] === "header:csrf-token", JSON.stringify(op.slots));
  assert.equal(op.match.operationName, "voyagerIdentityDashProfiles", "matched on the query's name, never its hash");
  assert.ok(warnings.some(w => /nonce or signature/.test(w) && /x-li-page-instance/.test(w)), warnings.join("; "));
  const s = JSON.stringify(op);
  for (const bad of [rep.session.csrf, rep.members[0].slug, rep.members[1].slug]) assert.ok(!s.includes(bad), `the operation holds ${bad}`);
});

test("twenty unseen profiles are read correctly: the right person, headline and place, whatever sections each has", async t => {
  const rep = await startReplica(); t.after(() => rep.close());
  const { operation: op, ex1 } = await teachProfile(rep);
  // the answer to pick from: the learned extract and the fields a person wants
  const first = JSON.parse(/** @type {string} */ (ex1[0].response.body));
  const picked = suggestPick(first, ["firstName", "lastName", "headline", "locationName", "publicIdentifier"], { extract: op.response.extract });
  assert.deepEqual(picked.missing, []);
  op.response.pick = picked.pick;
  const unseen = rep.members.slice(2, 22);
  assert.equal(unseen.length, 20);
  let right = 0;
  for (const p of unseen) {
    const r = await runOperation(op, { slug: p.slug }, deps(rep, op));
    assert.equal(r.ok, true, `${p.slug}: ${JSON.stringify(r)}`);
    const d = /** @type {any} */ (r.data);
    const row = Array.isArray(d) ? d[0] : d;
    if (row && row.firstName === p.firstName && row.lastName === p.lastName && row.headline === p.headline && row.locationName === p.locationName && row.publicIdentifier === p.slug) right++;
  }
  assert.equal(right, 20, "all twenty, none shown to it before");
  // a profile that is not there is the input's fault, not a changed site
  const none = await runOperation(op, { slug: "no-such-member-zz9" }, deps(rep, op));
  assert.equal(none.class, "input", JSON.stringify(none));
});

test("search and the inbox are taught the same way and read on inputs nobody showed", async t => {
  const rep = await startReplica(); t.after(() => rep.close());
  const ex1 = await page(rep, [searchCall(rep.origin, "estate", rep.session.csrf, rep.state.hash)]);
  const ex2 = await page(rep, [searchCall(rep.origin, "probate", rep.session.csrf, rep.state.hash)], 100);
  const { operation: search } = learnOperation({ name: "searchPeople", exchanges: ex1, exchanges2: ex2, examples: [{ keywords: "estate" }, { keywords: "probate" }], cookies: cookies(rep), trigger: { url: `${rep.origin}/search/results/people/?keywords={keywords}` } });
  assert.ok(search.slots.some((/** @type {any} */ s) => s.param === "keywords"), JSON.stringify(search.slots));
  for (const kw of ["legal", "attorney", "paralegal", "partner", "counsel"]) {
    const r = await runOperation(search, { keywords: kw }, deps(rep, search));
    assert.equal(r.ok, true, `${kw}: ${JSON.stringify(r).slice(0, 300)}`);
    const want = rep.members.filter(p => `${p.firstName} ${p.lastName} ${p.headline}`.toLowerCase().includes(kw)).slice(0, 10).map(fullName);
    const got = JSON.stringify(r.data);
    for (const name of want) assert.ok(got.includes(name), `${kw}: ${name} is in the results`);
  }
  // the inbox takes no input: the request is chosen from the capture, not found by an example
  const inboxCall = { method: "GET", url: `${rep.origin}/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX`, headers: { accept: "application/json", "csrf-token": rep.session.csrf, "x-li-lang": "en_US" } };
  const cap = await page(rep, [inboxCall]);
  const { operation: inbox } = learnOperation({ name: "readInbox", exchanges: cap, examples: [{}], cookies: cookies(rep), id: cap[0].id, trigger: { url: `${rep.origin}/messaging/` } });
  assert.deepEqual(inbox.params, []);
  const read = await runOperation(inbox, {}, deps(rep, inbox));
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(/** @type {any} */ (read.data).length, 2, "both conversations");
});

test("a message is learned by blocking it, held until the person says yes, then sent exactly once", async t => {
  const rep = await startReplica(); t.after(() => rep.close());
  const call = (/** @type {string} */ to, /** @type {string} */ text) => ({ method: "POST", url: `${rep.origin}/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage`, headers: { accept: "application/json", "content-type": "application/json", "csrf-token": rep.session.csrf, "x-li-lang": "en_US" },
    body: JSON.stringify({ message: { body: { text }, originToken: "client-gen-1" }, recipients: [to], trackingId: "t" }) });
  // the page's Send was pressed with its request BLOCKED: it was never made, so the replica has seen nothing
  const aborted = [call("ACoAAaaaaaaaaaaaaaaaaaaaaaaaaaaa1", "Hello Ada, thank you for the introduction"), call("ACoAAbbbbbbbbbbbbbbbbbbbbbbbbbbbb2", "Grace, the engagement letter is ready")]
    .map((c, i) => ({ id: i + 1, resourceType: "fetch", aborted: true, request: { method: c.method, url: c.url, headers: { ...c.headers, cookie: rep.session.cookie }, body: c.body } }));
  assert.equal(rep.state.sent.length, 0, "learning sent nothing");
  const { operation: op } = learnOperation({ name: "sendMessage", kind: "send", exchanges: [aborted[0]], exchanges2: [{ ...aborted[1], id: 100 }],
    examples: [{ to: "ACoAAaaaaaaaaaaaaaaaaaaaaaaaaaaa1", text: "Hello Ada, thank you for the introduction" }, { to: "ACoAAbbbbbbbbbbbbbbbbbbbbbbbbbbbb2", text: "Grace, the engagement letter is ready" }], cookies: cookies(rep), trigger: { url: `${rep.origin}/messaging/` } });
  const s = JSON.stringify(op);
  for (const bad of ["Hello Ada", "engagement letter", rep.session.csrf]) assert.ok(!s.includes(bad), `the operation holds ${bad}`);
  const inputs = { to: rep.members[4].id, text: "A short note from the intake team" };
  const held = await runOperation(op, inputs, deps(rep, op, { gate: () => ({ held: true, why: "a send waits for a yes" }) }));
  assert.equal(held.class, "held"); assert.equal(rep.state.sent.length, 0, "held: nothing sent");
  const done = await runOperation(op, inputs, deps(rep, op, { gate: () => null }));
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(rep.state.sent.length, 1, "once");
  assert.equal(rep.state.sent[0].message.body.text, "A short note from the intake team");
  assert.deepEqual(rep.state.sent[0].recipients, [rep.members[4].id]);
});

test("a deploy rotates the query hash: the read fails as a drift, is relearned from the page and proven on another profile before it is kept", async t => {
  const rep = await startReplica(); t.after(() => rep.close());
  const { operation: op } = await teachProfile(rep);
  const probe = rep.members[10];
  assert.equal((await runOperation(op, { slug: probe.slug }, deps(rep, op))).ok, true);
  rep.state.hash = "1f2e3d4c5b6a79881706f5e4d3c2b1a0";
  const broken = await runOperation(op, { slug: probe.slug }, deps(rep, op));
  assert.equal(broken.class, "drift", JSON.stringify(broken));
  const h = await healOperation(op, { slug: probe.slug }, { ...deps(rep, op), runTrigger: async () => ({ exchanges: await page(rep, [profileCall(rep.origin, probe.slug, rep.session.csrf, rep.state.hash)], 500), cookies: cookies(rep) }) }, { verifyInputs: { slug: rep.members[11].slug } });
  assert.equal(h.outcome, "healed", JSON.stringify(h));
  assert.ok(JSON.stringify(h.operation.request).includes(rep.state.hash));
  const after = await runOperation(h.operation, { slug: rep.members[12].slug }, deps(rep, h.operation));
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.ok(matches(h.operation.match, profileCall(rep.origin, "x-y-z", rep.session.csrf, rep.state.hash)) && operationNameOf({ method: "GET", url: profileCall(rep.origin, "x", "c", rep.state.hash).url, headers: {} }) === "voyagerIdentityDashProfiles");
});

test("a security check is recognised as a challenge, so the account stops; a profile the site refuses is not one", async t => {
  const rep = await startReplica(); t.after(() => rep.close());
  const { operation: op } = await teachProfile(rep);
  rep.state.checkpoint = true;
  const r = await runOperation(op, { slug: rep.members[3].slug }, deps(rep, op));
  assert.equal(r.class, "blocked", JSON.stringify(r));
  assert.equal(isChallenge(r.class, r.reason), true, String(r.reason));
  assert.equal(isChallenge("blocked", "HTTP 403 with no login or challenge markers: This profile can't be accessed"), false);
});
