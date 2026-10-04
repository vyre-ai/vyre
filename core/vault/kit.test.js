// @ts-check
// kit tests: the one-time page (one load, loopback Host only, expiry, headers that keep it out of
// caches and stop it loading anything), its QR payload, and that the Secret Key never reaches an
// event, a log or an audit row. The Secret Key is a fake, injected: the real one arrives with the
// account key hierarchy.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { serveKit, kitPayload, kitPage } from "./kit.js";
import { register } from "./tools/share.js";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fakeSk = () => `V2-Q7M2XK-${crypto.randomBytes(16).toString("hex").toUpperCase().slice(0, 26)}`;

/** GET with a chosen Host header, since fetch will not let a test set one. */
function get(url, host) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "GET", headers: host ? { host } : {} }, res => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("kit payload and page: the QR text, the fields, and nothing that loads or runs", () => {
  const sk = fakeSk();
  assert.equal(kitPayload({ acct: "Q7M2XK", sk, relay: "https://box.example.com", fp: "ABCD EFGH JKMN PQRS TVWX" }),
    `vyre-kit:v1:{"acct":"Q7M2XK","fp":"ABCD EFGH JKMN PQRS TVWX","relay":"https://box.example.com","sk":"${sk}"}`);
  const page = kitPage({ name: "alex", acct: "Q7M2XK", sk, fp: "ABCD EFGH JKMN PQRS TVWX", relay: "https://box.example.com", created: Date.UTC(2026, 8, 26) });
  for (const want of ["Account ID", "Q7M2XK", sk, "ABCD EFGH JKMN PQRS TVWX", "https://box.example.com", "Password", "<svg", "@media print", "#F4F1EA", "2026-09-26"]) assert.ok(page.includes(want), want);
  assert.doesNotMatch(page, /<script|<link|src=|https:\/\/fonts/i);
  assert.ok(kitPage({ name: "<b>", sk: "x", fp: "y", created: 0 }).includes("&lt;b&gt;"), "names are escaped");
});

test("serveKit: one load, only to its own loopback Host, then gone", async () => {
  const sk = fakeSk();
  let asked = 0;
  const served = [];
  const k = await serveKit({ secretKey: async () => { asked++; return sk; }, info: async () => ({ name: "alex", fp: "ABCD EFGH JKMN PQRS TVWX" }), onServed: () => served.push(1) });
  assert.match(k.url, /^http:\/\/127\.0\.0\.1:\d+\/kit\/[A-Za-z0-9_-]{32}$/);
  assert.ok(k.expires > Date.now() + 9 * 60_000 && k.expires <= Date.now() + 10 * 60_000);
  assert.equal(asked, 0, "the Secret Key is not asked for until the page loads");

  const u = new URL(k.url);
  assert.equal((await get(k.url, "evil.example.com")).status, 404, "a rebinding page gets nothing");
  assert.equal((await get(`${u.origin}/kit/wrong-token`)).status, 404);
  assert.equal(asked, 0, "misses do not use up the page");
  const r = /** @type {any} */ (await get(k.url));
  assert.equal(r.status, 200);
  assert.ok(r.body.includes(sk));
  assert.match(r.headers["cache-control"], /no-store/);
  assert.match(r.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(served.length, 1);
  assert.equal(await k.closed, "served");
  await assert.rejects(get(k.url), /ECONNREFUSED|ECONNRESET|socket hang up/);
});

test("serveKit expires unopened", async () => {
  const k = await serveKit({ secretKey: fakeSk, info: async () => ({ name: "alex", fp: "x" }), ttlMs: 50 });
  assert.equal(await k.closed, "expired");
  await assert.rejects(get(k.url), /ECONNREFUSED|ECONNRESET|socket hang up/);
});

test("vault.kit tool: the Secret Key reaches the page and nowhere else", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-kit-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const events = [], logs = [];
  const vault = new Vault({ db, dir: path.join(home, "vault"), config: { name: "alex", vault: { keystore: "file" } }, emit: (type, payload) => events.push({ type, payload }), log: m => logs.push(m) });
  vault.relayUrl = "https://box.example.com";
  const tools = new Map();
  const ctx = { tool: (name, d) => tools.set(name, d) };
  const sk = fakeSk();
  const reg = register({ ctx, vault, secretKey: async () => sk });
  t.after(async () => { await reg.stop(); db.close(); fs.rmSync(home, { recursive: true, force: true }); });

  const kit = tools.get("vault.kit");
  assert.deepEqual(kit.callers, ["cli", "local"]);
  assert.equal(await kit.presence.summary({}), "Print a recovery kit");
  const out = await kit.run({}, { caller: "cli" });
  assert.deepEqual(Object.keys(out).sort(), ["expires", "url"]);
  const again = await kit.run({}, { caller: "cli" });
  assert.equal((await get(out.url).catch(() => ({ status: "closed" }))).status !== 200, true, "a second kit ends the first");
  const page = /** @type {any} */ (await get(again.url));
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(sk));
  assert.ok(page.body.includes(await vault.share.myFingerprint()));
  await new Promise(r => setTimeout(r, 20));
  assert.ok(events.some(e => e.type === "vault.kit-printed"));
  const everywhere = JSON.stringify({ out, again, events, logs, audit: db.prepare("SELECT * FROM vault_audit").all(), people: vault.share.people() });
  assert.ok(!everywhere.includes(sk), "the Secret Key leaked outside the page");
  assert.ok(!everywhere.includes(sk.slice(10)), "part of the Secret Key leaked");
  for (const f of fs.readdirSync(home, { recursive: true })) {
    const p = path.join(home, String(f));
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p).includes(Buffer.from(sk)), `the Secret Key is on disk in ${f}`);
  }

  // Without a Secret Key there is nothing to print, and the error says so.
  const bare = new Map();
  const r2 = register({ ctx: { tool: (n, d) => bare.set(n, d) }, vault, secretKey: async () => null });
  await assert.rejects(bare.get("vault.kit").run({}, { caller: "cli" }), /no Secret Key yet/);
  await r2.stop();
});

test("in a real vyred: who sees the people tools, and the kit is a person's tool", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
  const mcp = as("mcp"), cli = as("cli");
  const listed = (await request("GET", "/v1/tools", undefined, { root, caller: "mcp" })).data.map(x => x.name);
  for (const n of ["vault.fingerprint", "vault.person.add"]) assert.ok(listed.includes(n), n);
  for (const n of ["vault.people", "vault.kit", "vault.people.verify"]) assert.ok(!listed.includes(n), n);
  assert.match((await mcp("vault.kit")).error.message, /not available to mcp/);
  assert.match((await cli("vault.kit")).error.message, /no Secret Key yet/);
  assert.match((await cli("vault.fingerprint")).data.fingerprint, /^([0-9A-Z]{4} ){4}[0-9A-Z]{4}$/);
  const card = (await cli("vault.identity")).data.card;
  assert.ok(card.startsWith("vyre-card:v2:"));
  const pend = (await mcp("vault.person.add", { card, name: "self" })).data;
  assert.equal(pend.pending.status, "pending");
  assert.deepEqual((await cli("vault.people")).data.people, []);
});

test("in a real vyred: account.create, then kit; the page holds the Secret Key, events, logs and audit do not", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const lines = [];
  const d = await start({ presence: present, root, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const made = await cli("vault.account.create", { password: "a long fixture password" });
  assert.ok(made.data, JSON.stringify(made.error));
  const sk = made.data.secretKey;
  assert.match(sk, /^V2-/);
  const k = (await cli("vault.kit")).data;
  assert.deepEqual(Object.keys(k).sort(), ["expires", "url"]);
  const page = /** @type {any} */ (await get(k.url));
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(sk), "the kit page carries the Secret Key");
  assert.ok(page.body.includes(made.data.acct));
  assert.equal((/** @type {any} */ (await get(k.url).catch(() => ({ status: 0 })))).status === 200, false, "a second load gets nothing");
  await new Promise(r => setTimeout(r, 20));
  const events = d.events.since(0, { limit: 5000 });
  assert.ok(events.some(e => e.type === "vault.kit-printed"));
  const audit = (await cli("vault.audit", { limit: 1000 })).data;
  const bare = sk.replace(/-/g, "");
  for (const [what, text] of [["events", JSON.stringify(events)], ["logs", lines.join("\n")], ["audit", JSON.stringify(audit)]]) {
    assert.ok(!text.includes(sk) && !text.includes(bare) && !text.includes(sk.split("-")[2]), `the Secret Key is in the ${what}`);
  }
});
