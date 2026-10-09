// @ts-check
// ops.* over a fake ctx and a fake site: learn from two runs of the page, call from inside the page with the credential resolved there, hold a send, block a write while it is taught,
// and never let a login value reach a result.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "./extension/caps/net.js";
import opsCap from "./extension/caps/ops.js";
import { makeCtx, request } from "./devtools-kit.js";
import { T } from "./test-support/trust.js";
import * as F from "../../lib/siteops/fixtures.js";

const ORIGIN = "https://app.example.com";
const ser = (/** @type {any} */ x) => JSON.stringify(x);
const people = (/** @type {string} */ t) => ({ total: 2, results: [{ id: "p-1", name: `${t} one`, profileUrl: `${ORIGIN}/in/1`, headline: "Engineer", meta: { score: 0.9, tags: ["a"] } }, { id: "p-2", name: `${t} two`, profileUrl: `${ORIGIN}/in/2`, headline: "Designer", meta: { score: 0.5, tags: [] } }] });

/** A fake browser tab on the site: navigating to /search?q=... makes the page send what the fixture says it sends, and fetches from the page are answered by a tiny server. */
function world(extra = {}) {
  const bodies = new Map();
  const k = makeCtx({ tabUrl: `${ORIGIN}/search?q=x`, respond: {
    "Network.getResponseBody": (/** @type {any} */ p) => ({ body: bodies.get(p.requestId) ?? "", base64Encoded: false }),
    "Runtime.evaluate": (/** @type {any} */ p) => {
      const e = String(p.expression);
      if (e.includes("localStorage")) return { result: { value: { origin: ORIGIN, url: `${ORIGIN}/search?q=x`, cookie: { sid: F.SECRET_COOKIE }, local: { csrf: F.CSRF }, session: {} } } };
      if (e.includes("fetch(P.url")) {
        const P = JSON.parse(e.match(/\}\)\((\{.*\})\)$/s)?.[1] || "{}");
        world.fetches.push(P);
        const u = new URL(P.url);
        if (P.init.method === "POST") return { result: { value: { status: 201, mime: "application/json", headers: { "content-type": "application/json" }, body: ser({ ok: true, id: "m-9" }) } } };
        const okCsrf = P.init.headers["x-csrf-token"] === F.CSRF;
        return { result: { value: okCsrf ? { status: 200, mime: "application/json", headers: { "content-type": "application/json" }, body: ser(people(u.searchParams.get("q") || "")) } : { status: 403, mime: "application/json", headers: {}, body: ser({ error: "csrf" }) } } };
      }
      return { result: { value: 1 } };
    },
    ...extra,
  } });
  let n = 0;
  /** @type {any} */ (k.ctx).call = async (/** @type {string} */ op, /** @type {any} */ a) => {
    world.calls.push([op, a]);
    if (op === "tabs.navigate") {
      const q = new URL(a.url).searchParams.get("q") || "";
      const id = `n${++n}`;
      const body = ser(people(q));
      bodies.set(id, body);
      request(k, 1, { id, url: `${ORIGIN}/api/v2/search?q=${encodeURIComponent(q)}&limit=20`, headers: { accept: "application/json", "x-csrf-token": F.CSRF }, extra: { Cookie: `sid=${F.SECRET_COOKIE}; theme=dark` }, type: "Fetch", status: 200, mime: "application/json", size: body.length });
      return { id };
    }
    if (op === "page.act") {
      // the page's own Send: it posts, and the interceptor (net.on block) fails it
      const id = `w${++n}`;
      request(k, 1, { id, method: "POST", url: `${ORIGIN}/api/v2/messages`, headers: { "content-type": "application/json", "x-csrf-token": F.CSRF }, extra: { Cookie: `sid=${F.SECRET_COOKIE}` }, type: "Fetch",
        postData: ser({ recipient: world.sendTo, body: world.sendText, channel: "direct" }), failed: "net::ERR_BLOCKED_BY_CLIENT" });
      return { ok: true };
    }
    return {};
  };
  return k;
}
world.fetches = /** @type {any[]} */ ([]);
world.calls = /** @type {any[]} */ ([]);
world.sendTo = "ada-lovelace"; world.sendText = "hello there friend";
const reset = () => { world.fetches.length = 0; world.calls.length = 0; };

const learnArgs = { tab: 1, name: "searchPeople", kind: "read", trigger: { url: `${ORIGIN}/search?q={query}` }, examples: [{ query: "alpha corp" }, { query: "beta works" }] };

test("ops.learn: two runs of the page become an operation; the login values never leave the worker", async () => {
  reset();
  const k = world();
  await T(net.ops["net.start"])({ tab: 1 }, k.ctx);
  const r = await T(opsCap.ops["ops.learn"])(learnArgs, k.ctx);
  assert.equal(r.ok, true, ser(r));
  const op = r.operation;
  assert.equal(op.name, "searchPeople");
  assert.deepEqual(op.slots.find((/** @type {any} */ s) => s.param === "query").at, ["query:q"]);
  assert.ok(op.slots.some((/** @type {any} */ s) => s.ref === "session:csrf"));
  for (const raw of [F.SECRET_COOKIE, F.CSRF, "alpha corp", "beta works"]) assert.ok(!ser(r).includes(raw), `leaked ${raw}`);
  assert.equal(world.calls.filter(c => c[0] === "tabs.navigate").length, 2, "the trigger ran once per example");
  assert.equal(k.calls("Fetch.enable").length, 0, "a read blocks nothing");
});

test("ops.call: the credential is resolved here and rides only into the page's own fetch; the answer is classified, extracted and clean", async () => {
  reset();
  const k = world();
  const learned = await T(opsCap.ops["ops.learn"])(learnArgs, k.ctx);
  world.fetches.length = 0;
  const out = await T(opsCap.ops["ops.call"])({ tab: 1, op: learned.operation, inputs: { query: "gamma labs" } }, k.ctx);
  assert.equal(out.ok, true, ser(out));
  assert.equal(out.data[0].name, "gamma labs one");
  assert.equal(world.fetches.length, 1, "one request");
  assert.equal(world.fetches[0].init.headers["x-csrf-token"], F.CSRF, "resolved from the page's storage, inside the page's fetch");
  assert.equal(world.fetches[0].init.credentials, "include");
  assert.equal(world.fetches[0].origin, ORIGIN);
  for (const raw of [F.SECRET_COOKIE, F.CSRF]) assert.ok(!ser(out).includes(raw), `leaked ${raw}`);
  // bad input: nothing is sent
  world.fetches.length = 0;
  assert.equal((await T(opsCap.ops["ops.call"])({ tab: 1, op: learned.operation, inputs: {} }, k.ctx)).class, "input");
  assert.equal(world.fetches.length, 0);
});

test("ops.call refuses a tab on another site, stop, a refused floor; ops.check names which references resolve and never their values", async () => {
  reset();
  const k = world();
  const learned = await T(opsCap.ops["ops.learn"])(learnArgs, k.ctx);
  const chk = await T(opsCap.ops["ops.check"])({ tab: 1, op: learned.operation }, k.ctx);
  assert.deepEqual(chk, { ok: true, onSite: true, refs: { "session:csrf": true } });
  const k2 = world({ "Runtime.evaluate": () => ({ result: { value: { origin: "https://other.example", url: "https://other.example/", cookie: {}, local: {}, session: {} } } }) });
  await assert.rejects(T(opsCap.ops["ops.call"])({ tab: 1, op: learned.operation, inputs: { query: "gamma labs" } }, k2.ctx), (/** @type {any} */ e) => e.code === "bad_request" && /not https:\/\/app\.example\.com|open the site/.test(e.message));
  k.state.floor = () => ({ allow: false, why: "blind" });
  await assert.rejects(T(opsCap.ops["ops.call"])({ tab: 1, op: learned.operation, inputs: { query: "gamma labs" } }, k.ctx), (/** @type {any} */ e) => e.code === "blocked");
  k.state.floor = () => ({ allow: true });
  k.state.stopped = () => true;
  const w = { ...learned.operation, kind: "change", request: { ...learned.operation.request, method: "POST" } };
  await assert.rejects(T(opsCap.ops["ops.call"])({ tab: 1, op: w, inputs: { query: "x y z" } }, k.ctx), (/** @type {any} */ e) => e.code === "stopped");
});

/** A send operation as learned. */
async function sendOp(/** @type {ReturnType<typeof world>} */ k) {
  const args = { tab: 1, name: "sendMessage", kind: "send", trigger: { url: `${ORIGIN}/inbox?q=x`, steps: [{ action: "click", selector: { role: "button", name: "Send" } }] }, examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }] };
  world.sendTo = "ada-lovelace"; world.sendText = "hello there friend";
  // the fake page sends a different value on each run; the fixture reads these
  let run = 0;
  const base = /** @type {any} */ (k.ctx).call;
  /** @type {any} */ (k.ctx).call = async (/** @type {string} */ op, /** @type {any} */ a, /** @type {any} */ t) => { if (op === "page.act") { run++; world.sendTo = run === 1 ? "ada-lovelace" : "grace-hopper"; world.sendText = run === 1 ? "hello there friend" : "second text here"; } return base(op, a, t); };
  return args;
}

test("ops.learn of a write asks first; once asked it blocks every write while the page's own Send is pressed, sends nothing, and puts the blocks back", async () => {
  reset();
  const k = world();
  const args = await sendOp(k);
  const heldFirst = await T(opsCap.ops["ops.learn"])(args, k.ctx);
  assert.equal(heldFirst.held, true);
  assert.equal(world.calls.length, 0, "nothing ran before the yes");
  const r = await T(opsCap.ops["ops.learn"])({ ...args, asked: true }, k.ctx);
  assert.equal(r.ok, true, ser(r));
  assert.equal(r.operation.kind, "send");
  assert.equal(r.aborted, true);
  const click = world.calls.find(c => c[0] === "page.act");
  assert.ok(click, "the page's Send was pressed");
  assert.equal(k.calls("Fetch.enable").length > 0, true, "request interception was on while it ran");
  assert.deepEqual((await T(net.ops["net.rules"])({ tab: 1 }, k.ctx)).rules, [], "every block rule was removed afterwards");
  for (const raw of [F.SECRET_COOKIE, F.CSRF, "ada-lovelace", "hello there friend", "grace-hopper"]) assert.ok(!ser(r).includes(raw), `leaked ${raw}`);
  assert.equal(world.fetches.length, 0, "no request was made from the page");
});

test("ops.call of a send is held until asked, then made exactly once; a lost answer is not retried", async () => {
  reset();
  const k = world();
  const args = await sendOp(k);
  const learned = await T(opsCap.ops["ops.learn"])({ ...args, asked: true }, k.ctx);
  const inputs = { recipient: "alan-turing", text: "a fresh note" };
  world.fetches.length = 0;
  const h = await T(opsCap.ops["ops.call"])({ tab: 1, op: learned.operation, inputs }, k.ctx);
  assert.equal(h.held, true);
  assert.ok(h.fields.some((/** @type {any} */ f) => f.name === "recipient"));
  assert.equal(world.fetches.length, 0, "held: nothing sent");
  const ok = await T(opsCap.ops["ops.call"])({ tab: 1, op: learned.operation, inputs, asked: true }, k.ctx);
  assert.equal(ok.ok, true, ser(ok));
  assert.equal(world.fetches.length, 1);
  assert.deepEqual(JSON.parse(world.fetches[0].init.body), { recipient: "alan-turing", body: "a fresh note", channel: "direct" });
  assert.equal(world.fetches[0].init.headers["x-csrf-token"], F.CSRF);
  const k2 = world({ "Runtime.evaluate": (/** @type {any} */ p) => { const e = String(p.expression); if (e.includes("localStorage")) return { result: { value: { origin: ORIGIN, url: ORIGIN, cookie: {}, local: { csrf: F.CSRF }, session: {} } } }; if (e.includes("fetch(P.url")) { world.fetches.push(1); return { exceptionDetails: { text: "Failed to fetch" } }; } return { result: { value: 1 } }; } });
  world.fetches.length = 0;
  const lost = await T(opsCap.ops["ops.call"])({ tab: 1, op: learned.operation, inputs, asked: true }, k2.ctx);
  assert.equal(lost.ok, false);
  assert.equal(lost.ambiguous, true, "the request may have left: the outcome is unknown, not 'failed'");
  assert.match(lost.next, /check the site before any retry/);
  assert.equal(world.fetches.length, 1, "no retry");
});

test("ops.heal refuses a write, and does not try the same operation twice in ten minutes", async () => {
  reset();
  const k = world();
  const learned = await T(opsCap.ops["ops.learn"])(learnArgs, k.ctx);
  const w = await T(opsCap.ops["ops.heal"])({ tab: 1, op: { ...learned.operation, kind: "send" }, inputs: { query: "gamma labs" } }, k.ctx);
  assert.equal(w.outcome, "failed");
  assert.match(w.reason, /relearned with ops\.learn/);
  const a = await T(opsCap.ops["ops.heal"])({ tab: 1, op: learned.operation, inputs: { query: "gamma labs" }, force: true }, k.ctx);
  assert.ok(["healed", "unchanged", "failed"].includes(a.outcome), ser(a));
  const b = await T(opsCap.ops["ops.heal"])({ tab: 1, op: learned.operation, inputs: { query: "gamma labs" } }, k.ctx);
  assert.equal(b.class, "rate");
});

test("ops.scout lists the candidate requests of the last capture in a few lines", async () => {
  reset();
  const k = world();
  await T(opsCap.ops["ops.learn"])(learnArgs, k.ctx);
  const s = await T(opsCap.ops["ops.scout"])({ tab: 1, examples: { query: "alpha corp" } }, k.ctx);
  assert.ok(s.candidates.length >= 1);
  assert.match(s.candidates[0].call, /GET app\.example\.com\/api\/v2\/search/);
  assert.deepEqual(s.candidates[0].carries, ["query"]);
  assert.ok(ser(s).length < 4000);
  for (const raw of [F.SECRET_COOKIE, F.CSRF]) assert.ok(!ser(s).includes(raw));
});

test("ops.learn with the fields the person wants: the picks are found in the learned answer, and a field that is not there is named", async () => {
  reset();
  const k = world();
  const r = await T(opsCap.ops["ops.learn"])({ ...learnArgs, wants: ["name", "headline", "salary"] }, k.ctx);
  assert.equal(r.ok, true, ser(r));
  assert.deepEqual(r.operation.response.pick, ["name", "headline"]);
  assert.deepEqual(r.missingFields, ["salary"]);
  const out = await T(opsCap.ops["ops.call"])({ tab: 1, op: r.operation, inputs: { query: "gamma labs" } }, k.ctx);
  assert.deepEqual(Object.keys(out.data[0]).sort(), ["headline", "name"], "only what was asked for comes back");
});
