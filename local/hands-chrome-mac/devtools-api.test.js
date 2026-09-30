// @ts-check
// api.learn / api.catalog / api.call over a fake ctx: catalog from the net buffer, storage by
// origin, calls made from inside the page, credentials never returned, acting rules for writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import api from "./extension/caps/api.js";
import net from "./extension/caps/net.js";
import { makeCtx, request } from "./devtools-kit.js";

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
  await net.ops["net.start"]({ tab: 1 }, k.ctx);
  request(k, 1, { id: "c1", url: `${GHL}/contacts/${CONTACT}?locationId=${LOC}`, headers: { Authorization: `Bearer ${JWT}` }, type: "XHR" });
  request(k, 1, { id: "c2", method: "PUT", url: `${GHL}/contacts/${CONTACT}`, headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json" }, postData: JSON.stringify({ firstName: "Alex", apiKey: "KEYVALUEabcdef123456" }), type: "XHR" });
  request(k, 1, { id: "c3", url: "https://services.gohighlevel.example/workflows/3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a/status", headers: {}, extra: { Cookie: "sid=COOKIEVALUE123456" }, type: "Fetch" });
  return { k, st };
}

test("api.learn builds a catalog from the net buffer and stores it by origin", async () => {
  const { k, st } = await world();
  const r = await api.ops["api.learn"]({ tab: 1 }, k.ctx);
  assert.equal(r.seen, 3);
  assert.equal(r.learned, 3);
  assert.deepEqual(r.origins, [GHL]);
  const s = ser(r);
  for (const raw of [JWT, LOC, CONTACT, "KEYVALUEabcdef123456", "COOKIEVALUE123456", "Alex"]) assert.ok(!s.includes(raw), "leaked " + raw);
  assert.ok(r.entries.some(e => e.pathTemplate === "/workflows/{id}/status" && e.authKind === "cookie"));
  const stored = st.m.get("api.catalog");
  assert.equal(Object.keys(stored)[0], GHL);
  assert.ok(!ser(stored).includes(JWT));
  const cat = await api.ops["api.catalog"]({ tab: 1 }, k.ctx);
  assert.equal(cat.entries.length, 3);
  const other = await api.ops["api.catalog"]({ origin: "https://nope.example" }, k.ctx);
  assert.equal(other.entries.length, 0);
});

test("api.learn honors since and the catalog is bounded by origin count", async () => {
  const { k, st } = await world();
  const none = await api.ops["api.learn"]({ tab: 1, since: Date.now() + 60_000 }, k.ctx);
  assert.equal(none.learned, 0);
  const many = {};
  for (let i = 0; i < 25; i++) many["https://o" + i + ".example"] = { updated: i, entries: [] };
  await st.session.set({ "api.catalog": many });
  await api.ops["api.learn"]({ tab: 1 }, k.ctx);
  assert.ok(Object.keys(st.m.get("api.catalog")).length <= 20);
});

test("api.call GET runs in the page with the captured bearer, returns a redacted response", async () => {
  const { k } = await world();
  const { entries } = await api.ops["api.learn"]({ tab: 1 }, k.ctx);
  const get = entries.find(e => e.method === "GET" && e.pathTemplate === "/contacts/{id}");
  const before = k.calls("Runtime.evaluate").length;
  const out = await api.ops["api.call"]({ tab: 1, entryId: get.id, params: { path: { id: CONTACT }, query: { locationId: LOC } } }, k.ctx);
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
  const { entries } = await api.ops["api.learn"]({ tab: 1 }, k.ctx);
  const put = entries.find(e => e.method === "PUT");
  const get = entries.find(e => e.pathTemplate === "/contacts/{id}" && e.method === "GET");
  k.state.stopped = () => true;
  await assert.rejects(api.ops["api.call"]({ tab: 1, entryId: put.id, params: { path: { id: CONTACT }, body: { firstName: "Sam" } } }, k.ctx), e => e.code === "stopped");
  assert.equal((await api.ops["api.call"]({ tab: 1, entryId: get.id, params: { path: { id: CONTACT } } }, k.ctx)).status, 200);
  k.state.stopped = () => false;
  const seen = [];
  k.state.floor = (t, o) => { seen.push(o); return { allow: false, why: "hands-only" }; };
  await assert.rejects(api.ops["api.call"]({ tab: 1, entryId: put.id, params: { path: { id: CONTACT } } }, k.ctx), e => e.code === "blocked");
  assert.deepEqual(seen, ["api.call"]);
  k.state.floor = () => ({ allow: true });
  const ok = await api.ops["api.call"]({ tab: 1, entryId: put.id, params: { path: { id: CONTACT }, body: { firstName: "Sam" } } }, k.ctx);
  assert.equal(ok.method, "PUT");
  const payload = JSON.parse(k.calls("Runtime.evaluate").at(-1).params.expression.match(/\}\)\((\{.*\})\)$/s)[1]);
  assert.equal(payload.init.body, '{"firstName":"Sam"}');
});

test("api.call errors: unknown entry, missing path parameter, moved tab, no captured credential", async () => {
  const { k } = await world();
  const { entries } = await api.ops["api.learn"]({ tab: 1 }, k.ctx);
  const get = entries.find(e => e.pathTemplate === "/contacts/{id}" && e.method === "GET");
  await assert.rejects(api.ops["api.call"]({ tab: 1, entryId: "e_nope" }, k.ctx), e => e.code === "not_found");
  await assert.rejects(api.ops["api.call"]({ tab: 1, entryId: get.id, params: {} }, k.ctx), e => e.code === "bad_request" && /id/.test(e.message));
  k.respond["Runtime.evaluate"] = { result: { value: { originMismatch: "https://other.example" } } };
  await assert.rejects(api.ops["api.call"]({ tab: 1, entryId: get.id, params: { path: { id: CONTACT } } }, k.ctx), e => e.code === "bad_request");
  net.onEvent({ event: "tabs.removed", tab: 1 }, k.ctx);
  k.respond["Runtime.evaluate"] = { result: { value: { status: 401, headers: {}, body: "no" } } };
  const out = await api.ops["api.call"]({ tab: 1, entryId: get.id, params: { path: { id: CONTACT } } }, k.ctx);
  assert.match(out.authNote, /no captured request/);
  assert.equal(out.status, 401);
});

test("floor refusal blocks api.learn and api.catalog with a tab", async () => {
  const { k } = await world();
  k.state.floor = () => ({ allow: false, why: "blind" });
  await assert.rejects(api.ops["api.learn"]({ tab: 1 }, k.ctx), e => e.code === "blocked");
  await assert.rejects(api.ops["api.catalog"]({ tab: 1 }, k.ctx), e => e.code === "blocked");
});
