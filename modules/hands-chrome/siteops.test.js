// @ts-check
// siteops on the box: an operation runs in the agent's own Chrome over CDP (a fake one here): the login is the page's, references resolve from the page, a sign-in wall is plain, an outward
// call needs the yes that was already given, and nothing that signs a request is in a result.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBoxOperation, checkBoxOperation } from "./siteops.js";
import { learnOperation } from "../../lib/siteops/learn.js";
import * as F from "../../lib/siteops/fixtures.js";

const ORIGIN = "https://app.example.com";
const people = (/** @type {string} */ t) => ({ total: 1, results: [{ id: "p-1", name: `${t} one`, profileUrl: "u", headline: "h", meta: { score: 1, tags: [] } }] });
const read = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
/** Learned with no storage on the page: the csrf header is a reference by its own name, which only the page's traffic can supply. */
const readByHeader = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const send = () => learnOperation({ name: "sendMessage", kind: "send", exchanges: F.pageSend("ada-lovelace", "hello there friend"), exchanges2: F.pageSend("grace-hopper", "second text here"), examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/inbox` } }).operation;

/** A fake Chrome page: where it is, what it stores, what the site answers, and the events a navigation makes. */
function fakePage(/** @type {any} */ o = {}) {
  const st = { url: o.url || "about:blank", local: o.local || {}, cookie: o.cookie || { sid: F.SECRET_COOKIE }, fetches: /** @type {any[]} */ ([]), navigations: /** @type {string[]} */ ([]) };
  /** @type {Array<(m: any) => void>} */ const listeners = [];
  const emit = (/** @type {any} */ m) => { for (const l of [...listeners]) l({ sessionId: "s1", ...m }); };
  const cdp = {
    on: (/** @type {(m: any) => void} */ fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    waitFor: (/** @type {(m: any) => boolean} */ pred, ms = 2000) => new Promise(resolve => { const off = cdp.on(m => { if (pred(m)) { off(); resolve(m); } }); setTimeout(() => { off(); resolve(null); }, ms); }),
    async send(/** @type {string} */ method, /** @type {any} */ params) {
      if (method === "Page.navigate") {
        st.navigations.push(params.url);
        st.url = o.wall && /\/search|\/inbox|\/$/.test(params.url) ? `${ORIGIN}/login?next=/` : params.url;
        // the page makes its own requests as it loads, carrying the csrf header
        setImmediate(() => { emit({ method: "Network.requestWillBeSent", params: { requestId: "r1", request: { method: "GET", url: `${ORIGIN}/api/v2/search?q=x`, headers: { "x-csrf-token": F.CSRF } } } }); emit({ method: "Network.loadingFinished", params: { requestId: "r1" } }); emit({ method: "Page.loadEventFired", params: {} }); });
        return {};
      }
      if (method === "Runtime.evaluate") {
        const e = String(params.expression);
        if (e.includes("localStorage")) { let origin = ""; try { origin = new URL(st.url).origin; } catch { /* about:blank */ } return { result: { value: { origin, url: st.url, cookie: st.cookie, local: st.local, session: {} } } }; }
        if (e.includes("fetch(P.url")) {
          const P = JSON.parse(e.match(/\}\)\((\{.*\})\)$/s)?.[1] || "{}");
          st.fetches.push(P);
          if (P.init.method === "POST") return { result: { value: { status: 201, mime: "application/json", headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) } } };
          const ok = P.init.headers["x-csrf-token"] === F.CSRF;
          return { result: { value: { status: ok ? 200 : 403, mime: "application/json", headers: { "content-type": "application/json" }, body: JSON.stringify(ok ? people(new URL(P.url).searchParams.get("q") || "") : { error: "csrf" }) } } };
        }
      }
      return {};
    },
  };
  return { cdp, st };
}

test("a read runs in the agent's own Chrome: the site is opened, the reference resolved from the page's own traffic, the fetch made by the page, the answer extracted", async () => {
  const p = fakePage({ local: {} });
  const out = await runBoxOperation({ cdp: p.cdp, sessionId: "s1", op: readByHeader(), inputs: { query: "gamma labs" } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(readByHeader().slots.filter((/** @type {any} */ s) => s.ref).map((/** @type {any} */ s) => s.ref), ["session:x-csrf-token"]);
  assert.equal(/** @type {any} */ (out.data)[0].name, "gamma labs one");
  assert.equal(p.st.fetches.length, 1, "one request");
  assert.equal(p.st.fetches[0].init.headers["x-csrf-token"], F.CSRF, "resolved from what the page itself sent");
  assert.equal(p.st.fetches[0].init.credentials, "include");
  assert.equal(p.st.fetches[0].origin, ORIGIN);
  for (const raw of [F.SECRET_COOKIE, F.CSRF]) assert.ok(!JSON.stringify(out).includes(raw), `leaked ${raw}`);
});

test("a reference nothing holds yet makes the page run the operation's own trigger; a sign-in wall is plainly auth and nothing is sent", async () => {
  const p = fakePage({ url: `${ORIGIN}/feed`, local: { csrf: F.CSRF } });
  const out = await runBoxOperation({ cdp: p.cdp, sessionId: "s1", op: read(), inputs: { query: "gamma labs" } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(p.st.navigations, [], "already on the site and the storage held the reference: no navigation");
  const walled = fakePage({ wall: true });
  const w = await runBoxOperation({ cdp: walled.cdp, sessionId: "s1", op: read(), inputs: { query: "gamma labs" } });
  assert.equal(w.ok, false); assert.equal(w.class, "auth");
  assert.match(String(w.next), /sign in again/);
  assert.equal(walled.st.fetches.length, 0, "nothing was sent from a sign-in page");
});

test("an outward operation runs only with the yes that was already given; without it nothing is sent", async () => {
  const op = send();
  const p = fakePage({ url: `${ORIGIN}/feed`, local: { csrf: F.CSRF } });
  const held = await runBoxOperation({ cdp: p.cdp, sessionId: "s1", op, inputs: { recipient: "alan-turing", text: "a fresh note" } });
  assert.equal(held.class, "held");
  assert.equal(p.st.fetches.length, 0);
  const done = await runBoxOperation({ cdp: p.cdp, sessionId: "s1", op, inputs: { recipient: "alan-turing", text: "a fresh note" }, approved: true });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(p.st.fetches.length, 1);
  assert.deepEqual(JSON.parse(p.st.fetches[0].init.body), { recipient: "alan-turing", body: "a fresh note", channel: "direct" });
});

test("a check says whether this Chrome can sign for the operation: on the site, signed in, and which references the page can supply, by name only", async () => {
  const good = fakePage({ url: `${ORIGIN}/feed`, local: { csrf: F.CSRF } });
  assert.deepEqual(await checkBoxOperation({ cdp: good.cdp, sessionId: "s1", op: read() }), { ok: true, onSite: true, refs: { "session:csrf": true } });
  assert.equal(good.st.fetches.length, 0, "a check sends nothing");
  const lacking = fakePage({ url: `${ORIGIN}/feed`, local: {} });
  const c = await checkBoxOperation({ cdp: lacking.cdp, sessionId: "s1", op: read() });
  assert.equal(c.ok, false); assert.deepEqual(c.refs, { "session:csrf": false });
  const walled = fakePage({ wall: true });
  const w = await checkBoxOperation({ cdp: walled.cdp, sessionId: "s1", op: read() });
  assert.equal(w.ok, false); assert.match(String(w.reason), /sign-in page/);
});
