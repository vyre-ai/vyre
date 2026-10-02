// @ts-check
// An AI provider's API key (0.2.2 #20): vault.apikey.check makes one cheap call, vault.apikey.save checks first and keeps a good key as an
// api-credential that only vault.request can use. Against a fake provider on this machine; never a real one. Every key is a sample.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../../daemon/index.js";
import { tempHome, present } from "../../../test/helpers.js";
import { checkKey, baseOf, register } from "./apikey.js";
import { open, migrate } from "../../store/index.js";
import { Vault, MIGRATIONS, ensureMacColumns } from "../vault.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

/** A fake provider: answers GET /v1/models and /key for the one good key, 401 otherwise, and records every request's headers. */
async function provider(t, good) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers["x-api-key"], version: req.headers["anthropic-version"] });
    if (req.url === "/redirect/models") { res.writeHead(302, { location: "http://127.0.0.1:1/steal" }); return res.end(); }
    const ok = req.headers.authorization === `Bearer ${good}` || req.headers["x-api-key"] === good;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] } : { error: "bad key" }));
  });
  await new Promise(r => server.listen(0, () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { seen, base: `http://localhost:${/** @type {any} */ (server.address()).port}` };
}

async function daemon(t, presence = present) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence, log: () => {} });
  t.after(() => d.stop());
  return { d, reg: (tool, input = {}, caller = "cli", meta = {}) => d.registry.call(tool, input, caller, meta) };
}

test("check: one authenticated GET per kind, the key is never in the answer, and a bad key, an unreachable server and a redirect all fail plainly", async t => {
  const key = fake("good");
  const p = await provider(t, key);
  const ok = await checkKey({ kind: "openai", key, base_url: p.base + "/v1" });
  assert.deepEqual([ok.ok, ok.status, ok.models], [true, 200, 3]);
  assert.equal(p.seen[0].url, "/v1/models");
  assert.equal(p.seen[0].auth, `Bearer ${key}`);
  const an = await checkKey({ kind: "anthropic", key, base_url: p.base });
  assert.equal(an.ok, true);
  assert.deepEqual([p.seen[1].url, p.seen[1].xkey, p.seen[1].version], ["/v1/models", key, "2023-06-01"]);
  const orr = await checkKey({ kind: "openrouter", key, base_url: p.base + "/api/v1" });
  assert.equal(orr.ok, true); assert.equal(p.seen[2].url, "/api/v1/key");
  assert.ok(!JSON.stringify([ok, an, orr]).includes(key), "no answer carries the key");

  const bad = await checkKey({ kind: "openai", key: fake("bad"), base_url: p.base + "/v1" });
  assert.deepEqual([bad.ok, bad.status], [false, 401]); assert.match(bad.why, /did not accept/);
  assert.equal((await checkKey({ kind: "openai", key, base_url: "http://localhost:1/v1" })).ok, false, "nothing listening");
  const redirected = await checkKey({ kind: "openai", key, base_url: p.base + "/redirect" });
  assert.equal(redirected.ok, false, "a redirect is never followed with the key");
  // The base URL: https, or http for this machine only; no login, no query.
  for (const u of ["http://example.com/v1", "https://user:pw@example.com/v1", "https://example.com/v1?x=1", "ftp://example.com", "not a url", "https://169.254.169.254/latest"]) assert.throws(() => baseOf("openai", u), u);
  assert.equal(baseOf("openai", "https://api.deepseek.com/v1/").href, "https://api.deepseek.com/v1");
});

test("save: a good key is kept as an api-credential for the provider's host only, never shown, and a bad key or an unnamed host is refused and not stored", async t => {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "vault", MIGRATIONS); ensureMacColumns(db);
  const vault = new Vault({ db, dir: path.join(root, "vault"), config: { name: "test-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  const key = fake("good");
  const calls = [];
  // The provider is a function, not a network: it knows the one good key.
  const fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization, xkey: init.headers["x-api-key"] });
    const ok = init.headers.authorization === `Bearer ${key}` || init.headers["x-api-key"] === key;
    return new Response(JSON.stringify(ok ? { data: [{ id: "m1" }, { id: "m2" }] } : { error: "bad" }), { status: ok ? 200 : 401 });
  };
  const tools = new Map();
  register({ ctx: { tool: (n, d) => tools.set(n, d) }, vault, fetch });
  const save = (input, caller = "cli") => tools.get("vault.apikey.save").run(input, { caller });

  await assert.rejects(save({ kind: "openai", key: fake("bad"), base_url: "https://api.deepseek.com/v1" }), e => e.code === "key_refused");
  await assert.rejects(save({ kind: "openai", key, base_url: "http://localhost:11434/v1" }), /named internet host/);
  await assert.rejects(save({ kind: "openai", key, base_url: "https://93.184.216.34/v1" }), /named internet host/);
  assert.equal(calls.filter(c => /localhost|93\.184/.test(c.url)).length, 0, "an unnamed host is refused before any call");
  assert.equal(vault.list().items.length, 0, "a refused key stores nothing");

  const saved = await save({ kind: "openai", key, base_url: "https://api.deepseek.com/v1" });
  assert.deepEqual([saved.name, saved.base_url, saved.models], ["ai-openai-api.deepseek.com", "https://api.deepseek.com/v1", 2]);
  assert.ok(!JSON.stringify(saved).includes(key), "the answer never carries the key");
  const row = vault.row("ai-openai-api.deepseek.com");
  assert.equal(row.kind, "api-credential");
  const cfg = JSON.parse((await vault.fields(row, { sealed: true })).config);
  assert.deepEqual([cfg.hosts, cfg.auth.type], [["api.deepseek.com"], "bearer"]);
  assert.ok(!JSON.stringify(vault.list()).includes(key), "the listing never carries the key");
  await assert.rejects(vault.fields(row), /never handed out/, "only vault.request can use it");
  // The provider's own address needs no host in the name; anthropic takes its key in x-api-key.
  const own = await save({ kind: "anthropic", key });
  assert.equal(own.name, "ai-anthropic");
  assert.equal(calls[calls.length - 1].xkey, key);
  assert.equal(JSON.parse((await vault.fields(vault.row("ai-anthropic"), { sealed: true })).config).auth.header, "x-api-key");
});

test("check and save are the person's own: a model, an agent, a module and a hook are refused, and save needs a proof when presence is real", async t => {
  const key = fake("good");
  const p = await provider(t, key);
  const { reg } = await daemon(t);
  const input = { kind: "openai", key, base_url: p.base + "/v1" };
  for (const tool of ["vault.apikey.check", "vault.apikey.save"]) {
    for (const [caller, meta] of [["mcp", { thread: "t-1" }], ["mcp:agent:kit", { agent: "kit", thread: "t-1" }], ["harness", {}], ["module:sessions", {}], ["hook", {}]]) {
      const r = await reg(tool, input, caller, meta);
      assert.ok(r.error && ["denied", "no_such_tool"].includes(r.error.code), `${tool} as ${caller}: ${JSON.stringify(r)}`);
    }
    assert.ok(p.seen.length === 0, "a refused caller made no call to the provider");
  }
  // Positive control: the same two calls from the person's own surface go through.
  assert.equal((await reg("vault.apikey.check", input, "local")).data.ok, true);
  // With a real presence rule, save asks for a proof and the check does not.
  const asked = [];
  const presence = { required: (_t, def) => Boolean(def && def.presence), verify: async ({ def, input }) => { asked.push(await def.presence.summary(input)); return { ok: false, code: "presence_required", message: "a person must prove it" }; }, challenge: async () => ({ error: { code: "bad_input", message: "none" } }) };
  const strict = await daemon(t, presence);
  assert.equal((await strict.reg("vault.apikey.check", input, "local")).data.ok, true);
  assert.equal((await strict.reg("vault.apikey.save", input, "local")).error.code, "presence_required");
  assert.match(asked[0], /Keep your openai API key in the vault for localhost/);
});
