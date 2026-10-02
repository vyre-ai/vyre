// @ts-check
// api.learn / api.catalog / api.call over a fake ctx: catalog from the net buffer, storage by
// origin, calls made from inside the page, credentials never returned, acting rules for writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import api from "./extension/caps/api.js";
import net from "./extension/caps/net.js";
import { makeCtx, request } from "./devtools-kit.js";
import { T } from "./test-support/trust.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJlMTIzNDU";
const LOC = "Xq3RtYuIoPaSdFgHjKlZ";
const CONTACT = "aB3dE5fG7hJ9kL1mN2pQ";
const GHL = "https://services.gohighlevel.example";
const ser = x => JSON.stringify(x);

function storage() {
  const m = new Map();
  return { session: { get: async k => (m.has(k) ? { [k]: structuredClone(m.get(k)) } : {}), set: async o => { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); } }, m };
}

async function world(extra = {}) {
  const st = storage();
  const k = makeCtx({ respond: { "Runtime.evaluate": { result: { value: { status: 200, mime: "application/json", headers: { "content-type": "application/json" }, body: JSON.stringify({ contact: { id: 1, phone: "+15551230000", access_token: "LEAKEDTOKEN1234567890" } }) } } }, ...extra } });
  /** @type {any} */ (k.ctx).storage = st;
  await T(net.ops["net.start"])({ tab: 1 }, k.ctx);
  request(k, 1, { id: "c1", url: `${GHL}/contacts/${CONTACT}?locationId=${LOC}`, headers: { Authorization: `Bearer ${JWT}` }, type: "XHR" });
  request(k, 1, { id: "c2", method: "PUT", url: `${GHL}/contacts/${CONTACT}`, headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json" }, postData: JSON.stringify({ firstName: "Alex", apiKey: "KEYVALUEabcdef123456" }), type: "XHR" });
  request(k, 1, { id: "c3", url: "https://services.gohighlevel.example/workflows/3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a/status", headers: {}, extra: { Cookie: "sid=COOKIEVALUE123456" }, type: "Fetch" });
  return { k, st };
}

test("api.learn builds a catalog from the net buffer and stores it by origin", async () => {
  const { k, st } = await world();
  const r = await T(api.ops["api.learn"])({ tab: 1 }, k.ctx);
  assert.equal(r.seen, 3);
  assert.equal(r.learned, 3);
  assert.deepEqual(r.origins, [GHL]);
  const s = ser(r);
  for (const raw of [JWT, LOC, CONTACT, "KEYVALUEabcdef123456", "COOKIEVALUE123456", "Alex"]) assert.ok(!s.includes(raw), "leaked " + raw);
  assert.ok(r.entries.some(e => e.pathTemplate === "/workflows/{id}/status" && e.authKind === "cookie"));
  const stored = st.m.get("api.catalog");
  assert.equal(Object.keys(stored)[0], GHL);
  assert.ok(!ser(stored).includes(JWT));
  const cat = await T(api.ops["api.catalog"])({ tab: 1 }, k.ctx);
  assert.equal(cat.entries.length, 3);
  const other = await T(api.ops["api.catalog"])({ origin: "https://nope.example" }, k.ctx);
  assert.equal(other.entries.length, 0);
});

test("api.learn honors since and the catalog is bounded by origin count", async () => {
  const { k, st } = await world();
  const none = await T(api.ops["api.learn"])({ tab: 1, since: Date.now() + 60_000 }, k.ctx);
  assert.equal(none.learned, 0);
  const many = {};
  for (let i = 0; i < 25; i++) many["https://o" + i + ".example"] = { updated: i, entries: [] };
  await st.session.set({ "api.catalog": many });
  await T(api.ops["api.learn"])({ tab: 1 }, k.ctx);
  assert.ok(Object.keys(st.m.get("api.catalog")).length <= 20);
});

test("api.call GET runs in the page with the captured bearer, returns a redacted response", async () => {
  const { k } = await world();
  const { entries } = await T(api.ops["api.learn"])({ tab: 1 }, k.ctx);
  const get = entries.find(e => e.method === "GET" && e.pathTemplate === "/contacts/{id}");
  const before = k.calls("Runtime.evaluate").length;
  const out = await T(api.ops["api.call"])({ tab: 1, entryId: get.id, params: { path: { id: CONTACT }, query: { locationId: LOC } } }, k.ctx);
  const ev = k.calls("Runtime.evaluate");
  assert.equal(ev.length, before + 1);
  const payload = JSON.parse(ev.at(-1).params.expression.match(/\}\)\((\{.*\})\)$/s)[1]);
  assert.equal(payload.url, `${GHL}/contacts/${CONTACT}?locationId=${LOC}`);
  assert.equal(payload.init.headers.Authorization, `Bearer ${JWT}`, "credential travels only into the page's fetch");
  assert.equal(payload.init.credentials, "include");
  assert.equal(payload.origin, GHL);
  const s = ser(out);
  for (const raw of [JWT, "LEAKEDTOKEN1234567890"]) assert.ok(!s.includes(raw), "leaked " + raw);
  assert.equal(out.status, 200);
  assert.equal(JSON.parse(out.responseBody).contact.id, 1);
});

test("api.call for a write is acting: stop and floor refuse it; a GET is not", async () => {
  const { k } = await world();
  const { entries } = await T(api.ops["api.learn"])({ tab: 1 }, k.ctx);
  const put = entries.find(e => e.method === "PUT");
  const get = entries.find(e => e.pathTemplate === "/contacts/{id}" && e.method === "GET");
  k.state.stopped = () => true;
  await assert.rejects(T(api.ops["api.call"])({ tab: 1, entryId: put.id, params: { path: { id: CONTACT }, body: { firstName: "Sam" } } }, k.ctx), e => e.code === "stopped");
  assert.equal((await T(api.ops["api.call"])({ tab: 1, entryId: get.id, params: { path: { id: CONTACT } } }, k.ctx)).status, 200);
  k.state.stopped = () => false;
  const seen = [];
  k.state.floor = (t, o) => { seen.push(o); return { allow: false, why: "hands-only" }; };
  await assert.rejects(T(api.ops["api.call"])({ tab: 1, entryId: put.id, params: { path: { id: CONTACT } } }, k.ctx), e => e.code === "blocked");
  assert.deepEqual(seen, ["api.call"]);
  k.state.floor = () => ({ allow: true });
  // A write with the page's login is held until the person said yes (asked) or a plan they approved covers it (writeOk).
  const heldW = await T(api.ops["api.call"])({ tab: 1, entryId: put.id, params: { path: { id: CONTACT }, body: { firstName: "Sam" } } }, k.ctx);
  assert.equal(heldW.held, true);
  assert.equal(heldW.write, true);
  assert.equal(heldW.kind, "edit");
  assert.equal(k.calls("Runtime.evaluate").filter(s => String(s.params.expression).includes("firstName")).length, 0, "nothing was sent");
  const ok = await T(api.ops["api.call"])({ tab: 1, entryId: put.id, writeOk: true, params: { path: { id: CONTACT }, body: { firstName: "Sam" } } }, k.ctx);
  assert.equal(ok.method, "PUT");
  const payload = JSON.parse(k.calls("Runtime.evaluate").at(-1).params.expression.match(/\}\)\((\{.*\})\)$/s)[1]);
  assert.equal(payload.init.body, '{"firstName":"Sam"}');
});

test("api.call errors: unknown entry, missing path parameter, moved tab, no captured credential", async () => {
  const { k } = await world();
  const { entries } = await T(api.ops["api.learn"])({ tab: 1 }, k.ctx);
  const get = entries.find(e => e.pathTemplate === "/contacts/{id}" && e.method === "GET");
  await assert.rejects(T(api.ops["api.call"])({ tab: 1, entryId: "e_nope" }, k.ctx), e => e.code === "not_found");
  await assert.rejects(T(api.ops["api.call"])({ tab: 1, entryId: get.id, params: {} }, k.ctx), e => e.code === "bad_request" && /id/.test(e.message));
  k.respond["Runtime.evaluate"] = { result: { value: { originMismatch: "https://other.example" } } };
  await assert.rejects(T(api.ops["api.call"])({ tab: 1, entryId: get.id, params: { path: { id: CONTACT } } }, k.ctx), e => e.code === "bad_request");
  net.onEvent({ event: "tabs.removed", tab: 1 }, k.ctx);
  k.respond["Runtime.evaluate"] = { result: { value: { status: 401, headers: {}, body: "no" } } };
  const out = await T(api.ops["api.call"])({ tab: 1, entryId: get.id, params: { path: { id: CONTACT } } }, k.ctx);
  assert.match(out.authNote, /no captured request/);
  assert.equal(out.status, 401);
});

test("floor refusal blocks api.learn and api.catalog with a tab", async () => {
  const { k } = await world();
  k.state.floor = () => ({ allow: false, why: "blind" });
  await assert.rejects(T(api.ops["api.learn"])({ tab: 1 }, k.ctx), e => e.code === "blocked");
  await assert.rejects(T(api.ops["api.catalog"])({ tab: 1 }, k.ctx), e => e.code === "blocked");
});

test("api.route: a read is tried through the learned API first and verified; anything else says route ui with why", async () => {
  const { k } = await world();
  await T(api.ops["api.learn"])({ tab: 1 }, k.ctx);
  const hit = await T(api.ops["api.route"])({ tab: 1, hint: "contact details", params: { path: { id: CONTACT }, query: { locationId: LOC } } }, k.ctx);
  assert.equal(hit.route, "api");
  assert.equal(hit.status, 200);
  assert.equal(hit.pathTemplate, "/contacts/{id}");
  assert.ok(!ser(hit).includes(JWT) && !ser(hit).includes("LEAKEDTOKEN1234567890"), "the credential stays out of the answer");
  const before = k.calls("Runtime.evaluate").length;
  const none = await T(api.ops["api.route"])({ tab: 1, hint: "invoices payments" }, k.ctx);
  assert.equal(none.route, "ui");
  assert.match(none.why, /no learned read matches/);
  assert.equal(k.calls("Runtime.evaluate").length, before, "no request is made when nothing matches");
  const needs = await T(api.ops["api.route"])({ tab: 1, hint: "contact" }, k.ctx);
  assert.equal(needs.route, "ui");
  assert.match(needs.why, /missing path parameter/);
  await assert.rejects(T(api.ops["api.route"])({ tab: 1, hint: "a of" }, k.ctx), e => e.code === "bad_request");
});

test("api.route never routes a write: it names the learned write beside route ui, and the write still asks", async () => {
  const { k } = await world();
  await T(api.ops["api.learn"])({ tab: 1 }, k.ctx);
  const sent = k.calls("Runtime.evaluate").length;
  const r = await T(api.ops["api.route"])({ tab: 1, hint: "contacts update", params: { path: { id: CONTACT } } }, k.ctx);
  assert.ok(r.route === "api" || r.route === "ui");
  assert.ok(!k.calls("Runtime.evaluate").slice(sent).some(c => /"method":"PUT"/.test(c.params.expression)), "no PUT was sent by routing");
  assert.ok(!r.writes || r.writes.every(w => w.method !== "GET"));
});

test("api.route: a stored endpoint that stops answering is not trusted, and is dropped after two failures", async () => {
  const dead = { "Runtime.evaluate": { result: { value: { status: 404, mime: "text/html", headers: {}, body: "gone" } } } };
  const { k, st } = await world(dead);
  await T(api.ops["api.learn"])({ tab: 1 }, k.ctx);
  const ask = () => T(api.ops["api.route"])({ tab: 1, hint: "workflows status", params: { path: { id: "3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a" } } }, k.ctx);
  const a = await ask();
  assert.equal(a.route, "ui");
  assert.equal(a.status, 404);
  assert.equal((await ask()).route, "ui");
  const left = Object.values(st.m.get("api.catalog")).flatMap(o => o.entries).filter(e => e.pathTemplate === "/workflows/{id}/status");
  assert.equal(left.length, 0, "dropped after two failures");
  assert.match((await ask()).why, /no learned read matches/);
});
