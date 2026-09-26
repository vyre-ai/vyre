// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudflare, dnsFor, waitTxt } from "./cloudflare.js";

const TOKEN = "fake-cf-token-0123456789";

/** A fake Cloudflare API over an in-memory record list. Records a log of calls. */
function fakeApi({ zones = [{ id: "z1", name: "vyre.run" }], records = [] } = {}) {
  const calls = [];
  let next = 1;
  const recs = records.map(r => ({ id: "r" + next++, ...r }));
  const reply = (result, status = 200) => new Response(JSON.stringify({ success: status < 400, errors: status < 400 ? [] : [{ code: 81044, message: "Record does not exist." }], result }), { status });
  /** @type {typeof globalThis.fetch} */
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    const headers = /** @type {any} */ (init.headers);
    calls.push({ method, path: url.pathname, query: url.search, auth: headers.authorization, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (headers.authorization !== `Bearer ${TOKEN}`) return reply(null, 403);
    const p = url.pathname.replace(/^\/client\/v4/, "");
    if (p === "/zones") return reply(zones.filter(z => z.name === url.searchParams.get("name") || url.searchParams.get("name") === "*"));
    let m;
    if ((m = p.match(/^\/zones\/z1\/dns_records$/))) {
      if (method === "GET") return reply(recs.filter(r => r.name === url.searchParams.get("name") && (!url.searchParams.get("type") || r.type === url.searchParams.get("type"))));
      const body = JSON.parse(String(init.body));
      const rec = { id: "r" + next++, ...body };
      recs.push(rec);
      return reply(rec);
    }
    if ((m = p.match(/^\/zones\/z1\/dns_records\/(\w+)$/))) {
      const i = recs.findIndex(r => r.id === m[1]);
      if (i < 0) return reply(null, 404);
      if (method === "GET") return reply(recs[i]);
      if (method === "DELETE") { recs.splice(i, 1); return reply({ id: m[1] }); }
      if (method === "PUT") { recs[i] = { id: m[1], ...JSON.parse(String(init.body)) }; return reply(recs[i]); }
    }
    return reply(null, 404);
  };
  return { fetch, calls, recs };
}

test("cloudflare: inside() accepts the zone and names under it only", () => {
  const cf = cloudflare({ token: TOKEN, fetch: fakeApi().fetch });
  assert.equal(cf.inside("vyre.run"), true);
  assert.equal(cf.inside("Box1.VYRE.run."), true);
  assert.equal(cf.inside("_acme-challenge.box1.vyre.run"), true);
  for (const bad of ["example.org", "vyre.run.evil.com", "notvyre.run", "xvyre.run", "run", ""]) assert.equal(cf.inside(bad), false, bad);
});

test("cloudflare: every method refuses a name outside the zone, before any request", async () => {
  const api = fakeApi();
  const cf = cloudflare({ token: TOKEN, fetch: api.fetch });
  for (const bad of ["example.org", "vyre.run.evil.com", "notvyre.run"]) {
    await assert.rejects(cf.find(bad), /not inside the vyre\.run zone/);
    await assert.rejects(cf.upsertA(bad, "100.64.0.1"), /not inside/);
    await assert.rejects(cf.addTxt(bad, "v"), /not inside/);
    await assert.rejects(cf.available(bad, "100.64.0.1"), /not inside/);
    await assert.rejects(dnsFor(cf).set(bad, "v"), /not inside/);
  }
  assert.equal(api.calls.length, 0);
});

test("cloudflare: remove() refuses a record that is not inside the zone", async () => {
  const api = fakeApi({ records: [{ type: "A", name: "www.example.org", content: "192.0.2.1" }] });
  const cf = cloudflare({ token: TOKEN, fetch: api.fetch });
  await assert.rejects(cf.remove("r1"), /not inside/);
  assert.equal(api.recs.length, 1);
  assert.ok(!api.calls.some(c => c.method === "DELETE"));
});

test("cloudflare: zoneId is looked up once and must be exactly the zone", async () => {
  const api = fakeApi();
  const cf = cloudflare({ token: TOKEN, fetch: api.fetch });
  assert.equal(await cf.zoneId(), "z1");
  assert.equal(await cf.zoneId(), "z1");
  assert.equal(api.calls.filter(c => c.path.endsWith("/zones")).length, 1);
  const none = cloudflare({ token: TOKEN, fetch: fakeApi({ zones: [] }).fetch });
  await assert.rejects(none.zoneId(), /exactly one zone/);
  const wrong = cloudflare({ token: TOKEN, fetch: fakeApi({ zones: [{ id: "z9", name: "vyre.run" }, { id: "z8", name: "vyre.run" }] }).fetch });
  await assert.rejects(wrong.zoneId(), /exactly one zone/);
});

test("cloudflare: upsertA creates, then updates in place, DNS only with ttl 60", async () => {
  const api = fakeApi();
  const cf = cloudflare({ token: TOKEN, fetch: api.fetch });
  const a = await cf.upsertA("box1.vyre.run", "100.64.0.1");
  assert.equal(a.content, "100.64.0.1");
  assert.equal(a.proxied, false);
  assert.equal(a.ttl, 60);
  const b = await cf.upsertA("box1.vyre.run", "100.64.0.2");
  assert.equal(b.id, a.id);
  assert.deepEqual(api.recs.map(r => r.content), ["100.64.0.2"]);
  await assert.rejects(cf.upsertA("box1.vyre.run", "not-an-ip"), /IPv4/);
});

test("cloudflare: upsertA collapses duplicate A records to one", async () => {
  const api = fakeApi({ records: [{ type: "A", name: "box1.vyre.run", content: "100.64.0.9" }, { type: "A", name: "box1.vyre.run", content: "100.64.0.8" }] });
  const cf = cloudflare({ token: TOKEN, fetch: api.fetch });
  await cf.upsertA("box1.vyre.run", "100.64.0.1");
  assert.deepEqual(api.recs.map(r => r.content), ["100.64.0.1"]);
});

test("cloudflare: available() is free, mine, or taken", async () => {
  const api = fakeApi({ records: [{ type: "A", name: "taken.vyre.run", content: "100.64.0.7" }, { type: "CNAME", name: "alias.vyre.run", content: "x.example.org" }, { type: "TXT", name: "txt.vyre.run", content: "\"hi\"" }] });
  const cf = cloudflare({ token: TOKEN, fetch: api.fetch });
  assert.deepEqual(await cf.available("free.vyre.run", "100.64.0.1"), { available: true, mine: false });
  assert.deepEqual(await cf.available("txt.vyre.run", "100.64.0.1"), { available: true, mine: false });
  assert.deepEqual(await cf.available("taken.vyre.run", "100.64.0.1"), { available: false, mine: false });
  assert.deepEqual(await cf.available("taken.vyre.run", "100.64.0.7"), { available: true, mine: true });
  assert.deepEqual(await cf.available("alias.vyre.run", "100.64.0.1"), { available: false, mine: false });
});

test("cloudflare: addTxt, find and remove through the acme adapter", async () => {
  const api = fakeApi();
  const cf = cloudflare({ token: TOKEN, fetch: api.fetch });
  const dns = dnsFor(cf);
  const id = await dns.set("_acme-challenge.box1.vyre.run", "abc_DEF-123");
  const found = await cf.find("_acme-challenge.box1.vyre.run", "TXT");
  assert.equal(found.length, 1);
  assert.equal(found[0].id, id);
  assert.equal(found[0].content, '"abc_DEF-123"');
  await dns.clear(id);
  assert.equal(api.recs.length, 0);
});

test("cloudflare: auth is a Bearer header and the token never appears in errors", async () => {
  const api = fakeApi();
  const cf = cloudflare({ token: TOKEN, fetch: api.fetch });
  await cf.zoneId();
  assert.equal(api.calls[0].auth, `Bearer ${TOKEN}`);
  assert.ok(!api.calls[0].query.includes(TOKEN));
  const leaky = cloudflare({ token: TOKEN, fetch: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: `Invalid token ${TOKEN}` }] }), { status: 403 }) });
  await assert.rejects(leaky.zoneId(), err => { assert.ok(!err.message.includes(TOKEN)); assert.match(err.message, /9109/); return true; });
  const down = cloudflare({ token: TOKEN, fetch: async () => { throw new TypeError(`fetch failed for ${TOKEN}`); } });
  await assert.rejects(down.zoneId(), err => { assert.ok(!err.message.includes(TOKEN)); return true; });
});

test("cloudflare: a failed zone lookup is retried on the next call", async () => {
  let n = 0;
  const api = fakeApi();
  const cf = cloudflare({ token: TOKEN, fetch: async (u, i) => (n++ === 0 ? new Response("oops", { status: 502 }) : api.fetch(u, i)) });
  await assert.rejects(cf.zoneId(), /HTTP 502/);
  assert.equal(await cf.zoneId(), "z1");
});

test("cloudflare: waitTxt gives up with the resolvers that never saw the value", async () => {
  // 192.0.2.1 is TEST-NET-1: nothing answers, so this exercises the timeout path offline.
  await assert.rejects(waitTxt("_acme-challenge.box1.example.test", "v", { resolvers: ["192.0.2.1"], timeoutMs: 10, pollMs: 1 }), /not seen by 192\.0\.2\.1/);
});
