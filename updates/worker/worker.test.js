// @ts-check
// The weekly update list Worker against a fake KV and a fake rate limiter: signup validation, one row per address,
// nothing in the keys or the logs that names an address, and unsubscribe by a signed link.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { subscriberId, subscriberToken, validEmail } from "./index.js";
import { CONSENT_TEXT, CONSENT_VERSION } from "./consent.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = "k".repeat(40);
const BASE = "https://vyre.run";

/** A Workers KV with the calls the Worker makes. */
function fakeKv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, list: async () => ({ keys: [...m.keys()].map((name) => ({ name })) }) };
}
/** A rate limiter that allows `n` calls per key, then refuses. */
function fakeLimiter(n) {
  const seen = new Map();
  return { limit: async ({ key }) => { const c = (seen.get(key) || 0) + 1; seen.set(key, c); return { success: c <= n }; } };
}
function env(over = {}) { return { UPDATES: fakeKv(), UPDATES_SECRET: SECRET, ORIGIN: BASE, ...over }; }

const GOOD = { name: "Ada Lovelace", email: "Ada@Example.com", consent: true, source: "/updates/" };
/** @param {any} e @param {any} body @param {Record<string,string>} [headers] */
function post(e, body, headers = {}, p = "/api/updates") {
  return worker.fetch(new Request(BASE + p, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "cf-connecting-ip": "203.0.113.7", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }), e);
}
const rows = (e) => [...e.UPDATES.m.entries()];

test("a signup stores one row with the fields the owner asked for", async () => {
  const e = env();
  const r = await post(e, GOOD);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { data: { ok: true } });
  assert.equal(rows(e).length, 1);
  const [key, val] = rows(e)[0];
  const row = JSON.parse(val);
  assert.deepEqual(Object.keys(row).sort(), ["confirmed_at", "consent_version", "created_at", "email", "name", "source"]);
  assert.equal(row.email, "ada@example.com");
  assert.equal(row.name, "Ada Lovelace");
  assert.equal(row.consent_version, CONSENT_VERSION);
  assert.equal(row.source, "/updates/");
  assert.equal(row.confirmed_at, null);
  assert.ok(!Number.isNaN(Date.parse(row.created_at)));
  assert.equal(key, "s:" + await subscriberId(SECRET, "ada@example.com"));
  assert.ok(!key.includes("ada") && !key.includes("example"), "the KV key holds no part of the address");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("the response never repeats the address", async () => {
  const e = env();
  for (const body of [GOOD, { ...GOOD, consent: false }, { ...GOOD, name: "" }]) {
    const text = await (await post(e, body)).text();
    assert.ok(!/example\.com/i.test(text));
  }
});

test("a second signup for the same address changes nothing and answers the same", async () => {
  const e = env();
  const a = await post(e, GOOD);
  const first = rows(e)[0][1];
  const b = await post(e, { ...GOOD, name: "Someone Else", email: " ADA@example.com " });
  assert.equal(b.status, a.status);
  assert.deepEqual(await b.json(), await a.json());
  assert.equal(rows(e).length, 1);
  assert.equal(rows(e)[0][1], first);
});

test("consent is required, and only an explicit yes counts", async () => {
  const e = env();
  for (const consent of [undefined, false, "", "no", "off", null, 0]) assert.equal((await post(e, { ...GOOD, consent })).status, 400, String(consent));
  for (const consent of [true, "on", "true"]) assert.equal((await post(env(), { ...GOOD, consent })).status, 200, String(consent));
  assert.equal(rows(e).length, 0);
});

test("names and addresses are validated", async () => {
  const e = env();
  const bad = [
    { name: "" }, { name: "   " }, { name: "x".repeat(81) }, { name: "Ada\u0000Lovelace" }, { name: "<script>" }, { name: 5 },
    { email: "" }, { email: "ada" }, { email: "ada@" }, { email: "@example.com" }, { email: "a@b" }, { email: "a b@example.com" },
    { email: "a@@example.com" }, { email: "a@example..com" }, { email: ".a@example.com" }, { email: "a.@example.com" },
    { email: "a@-example.com" }, { email: "a@example.c" }, { email: "a@example.com\r\nBcc: x@y.zz" }, { email: "x".repeat(65) + "@example.com" },
    { email: "a@" + "x".repeat(250) + ".com" }, { email: ["a@example.com"] }, { email: { a: 1 } },
  ];
  for (const b of bad) assert.equal((await post(e, { ...GOOD, ...b })).status, 400, JSON.stringify(b));
  assert.equal(rows(e).length, 0);
  for (const ok of ["a@example.com", "first.last+tag@sub.example.co.uk", "o'brien@example.org"]) assert.equal(validEmail(ok), true, ok);
});

test("the source is kept only when it is a site path", async () => {
  const e = env();
  await post(e, { ...GOOD, source: "https://evil.example/x" });
  assert.equal(JSON.parse(rows(e)[0][1]).source, "/");
  const f = env();
  await post(f, { ...GOOD, source: "/agenthome/" });
  assert.equal(JSON.parse(rows(f)[0][1]).source, "/agenthome/");
});

test("a filled honeypot looks like a success and stores nothing", async () => {
  const e = env();
  const r = await post(e, { ...GOOD, website: "https://spam.example" });
  assert.equal(r.status, 200);
  assert.equal(rows(e).length, 0);
});

test("requests that are too large, the wrong type or from another site are refused", async () => {
  const e = env();
  assert.equal((await post(e, JSON.stringify({ ...GOOD, name: "x".repeat(5000) }))).status, 413);
  assert.equal((await post(e, "name=a", { "content-type": "text/plain" })).status, 415);
  assert.equal((await post(e, "{not json")).status, 415);
  assert.equal((await post(e, "[1]")).status, 415);
  assert.equal((await post(e, GOOD, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(e, GOOD, { "sec-fetch-site": "cross-site", origin: BASE })).status, 403);
  assert.equal(rows(e).length, 0);
  assert.equal((await worker.fetch(new Request(BASE + "/api/updates"), e)).status, 405);
  assert.equal((await worker.fetch(new Request(BASE + "/api/other"), e)).status, 404);
});

test("each address gets a few tries a minute, and a refusal stores nothing", async () => {
  const e = env({ UPDATES_LIMITER: fakeLimiter(2) });
  assert.equal((await post(e, GOOD)).status, 200);
  assert.equal((await post(e, { ...GOOD, email: "b@example.com" })).status, 200);
  const r = await post(e, { ...GOOD, email: "c@example.com" });
  assert.equal(r.status, 429);
  assert.equal(rows(e).length, 2);
  assert.equal((await post(e, { ...GOOD, email: "c@example.com" }, { "cf-connecting-ip": "198.51.100.9" })).status, 200, "another address has its own count");
});

test("without a secret of 32 characters the list stays closed", async () => {
  for (const UPDATES_SECRET of [undefined, "short"]) {
    const e = env({ UPDATES_SECRET });
    assert.equal((await post(e, GOOD)).status, 503);
    assert.equal(rows(e).length, 0);
  }
});

test("the plain HTML form works without script", async () => {
  const e = env();
  const form = new URLSearchParams({ name: "Ada", email: "ada@example.com", consent: "on", website: "", source: "/" });
  const r = await post(e, form.toString(), { "content-type": "application/x-www-form-urlencoded" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/html/);
  const html = await r.text();
  assert.match(html, /You are on the list/);
  assert.ok(!/example\.com/.test(html));
  assert.match(r.headers.get("content-security-policy") || "", /default-src 'none'/);
  assert.equal(rows(e).length, 1);
  const bad = await post(e, new URLSearchParams({ name: "Ada", email: "nope", consent: "on" }).toString(), { "content-type": "application/x-www-form-urlencoded" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /valid email/);
});

test("nothing is written to a log, whatever happens", async () => {
  const seen = [];
  const saved = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) { saved[k] = console[k]; console[k] = (...a) => seen.push(a.map(String).join(" ")); }
  try {
    const e = env({ UPDATES_LIMITER: fakeLimiter(1) });
    await post(e, GOOD);
    await post(e, { ...GOOD, email: "bad" });
    await post(e, GOOD);
    const token = await subscriberToken(SECRET, await subscriberId(SECRET, "ada@example.com"));
    await worker.fetch(new Request(`${BASE}/api/updates/unsubscribe?t=${token}`, { method: "POST" }), env());
  } finally { for (const k of Object.keys(saved)) console[k] = saved[k]; }
  assert.deepEqual(seen, []);
  assert.ok(!/console\./.test(fs.readFileSync(path.join(HERE, "index.js"), "utf8").replace(/\/\/.*$/gm, "")), "index.js calls no console function");
});

/** @param {any} e @param {string} address */
async function tokenFor(e, address) {
  const r = await post(e, { ...GOOD, email: address });
  assert.equal(r.status, 200);
  return subscriberToken(SECRET, await subscriberId(SECRET, address));
}

test("the unsubscribe link asks first, and the button removes the row", async () => {
  const e = env();
  await post(e, { ...GOOD, email: "keep@example.com" });
  const t = await tokenFor(e, "ada@example.com");
  assert.equal(rows(e).length, 2);
  const get = await worker.fetch(new Request(`${BASE}/api/updates/unsubscribe?t=${t}`), e);
  assert.equal(get.status, 200);
  const html = await get.text();
  assert.match(html, /<form method="post"/);
  assert.equal(rows(e).length, 2, "opening the link, as a mail scanner does, removes nobody");
  const form = new URLSearchParams(/name="t" value="([^"]+)"/.exec(html)?.[1] ? { t: /name="t" value="([^"]+)"/.exec(html)[1] } : {});
  const del = await worker.fetch(new Request(`${BASE}/api/updates/unsubscribe`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }), e);
  assert.equal(del.status, 200);
  assert.match(await del.text(), /You are off the list/);
  assert.equal(rows(e).length, 1);
  assert.equal(JSON.parse(rows(e)[0][1]).email, "keep@example.com");
  const again = await worker.fetch(new Request(`${BASE}/api/updates/unsubscribe?t=${t}`, { method: "POST" }), e);
  assert.equal(again.status, 200, "a second click is harmless");
});

test("a mail client's one-click unsubscribe works", async () => {
  const e = env();
  const t = await tokenFor(e, "ada@example.com");
  const r = await worker.fetch(new Request(`${BASE}/api/updates/unsubscribe?t=${t}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }), e);
  assert.equal(r.status, 200);
  assert.equal(rows(e).length, 0);
});

test("a link that was not signed by this Worker removes nobody", async () => {
  const e = env();
  const t = await tokenFor(e, "ada@example.com");
  const [id, sig] = t.split(".");
  const flip = (s) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
  const other = await subscriberToken("z".repeat(40), id);
  const forged = [flip(sig) && `${id}.${flip(sig)}`, other, `${id}.`, id, "", "x.y", `${await subscriberId(SECRET, "ghost@example.com")}.${sig}`, t + "A"];
  for (const bad of forged) {
    const r = await worker.fetch(new Request(`${BASE}/api/updates/unsubscribe?t=${encodeURIComponent(bad)}`, { method: "POST" }), e);
    assert.equal(r.status, 400, bad);
  }
  assert.equal(rows(e).length, 1);
  assert.equal((await worker.fetch(new Request(`${BASE}/api/updates/unsubscribe`, { method: "POST" }), e)).status, 400);
});

test("the unsubscribe page puts nothing of the token in a referrer and is not cached", async () => {
  const e = env();
  const t = await tokenFor(e, "ada@example.com");
  const r = await worker.fetch(new Request(`${BASE}/api/updates/unsubscribe?t=${t}`), e);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("the configuration binds what the Worker uses and keeps request logs off", () => {
  const toml = fs.readFileSync(path.join(HERE, "wrangler.toml"), "utf8");
  assert.match(toml, /\[observability\]\s*\nenabled = false/);
  assert.match(toml, /binding = "UPDATES"/);
  assert.match(toml, /name = "UPDATES_LIMITER"/);
  assert.match(toml, /workers_dev = false/);
  assert.match(toml, /pattern = "vyre\.run\/api\/updates", zone_name = "vyre\.run"/);
  assert.match(toml, /pattern = "vyre\.run\/api\/updates\/\*", zone_name = "vyre\.run"/);
  assert.ok(!/UPDATES_SECRET\s*=/.test(toml), "the secret is never in the file");
  const ids = [...fs.readFileSync(path.join(HERE, "..", "..", "relay", "worker", "wrangler.toml"), "utf8").matchAll(/namespace_id = "(\d+)"/g)].map((m) => m[1]);
  assert.ok(!ids.includes(/namespace_id = "(\d+)"/.exec(toml)?.[1] || ""), "the limiter id is not one the relay uses");
});

test("the form on the site prints the promise the Worker records", () => {
  const SITE = path.join(HERE, "..", "..", "site");
  for (const p of ["updates/index.html", "index.html"]) {
    const html = fs.readFileSync(path.join(SITE, p), "utf8");
    assert.ok(html.includes(CONSENT_TEXT), `${p} shows the exact promise`);
    assert.match(html, /<form[^>]*action="\/api\/updates"[^>]*method="post"|<form[^>]*method="post"[^>]*action="\/api\/updates"/);
  }
});
