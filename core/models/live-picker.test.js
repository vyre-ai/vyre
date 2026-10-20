// @ts-check
// The model picker reads the LIVE list (0.3.3 G13): a real vyred, a real API-key account on a service of its own, and the registry's refresh asks that service through the inference door; what the person's
// picker lists is what the service answered (ids and labels), and the key is in no answer.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { boot, until } from "../sessions/testing/boot.js";
import { allowLoopbackForTests } from "../../lib/http.js";
allowLoopbackForTests();

const GOOD = "test-key-1234567890abcdef";

async function service(t) {
  const srv = http.createServer((req, res) => {
    const auth = req.headers.authorization === `Bearer ${GOOD}`;
    if (req.method === "GET" && /\/models$/.test(String(req.url))) { res.writeHead(auth ? 200 : 401, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "lab-small", display_name: "Lab Small" }, { id: "lab-large" }] })); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); }));
  return `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
}

test("a keyed account's model list comes from the service itself, through the door, and reaches the registry as { id, label }", async t => {
  process.env.VYRE_LEGACY_DIRECT_MODEL = "1";
  const w = await boot(t, { driver: "cli", vault: { "seed-item": "seed-value" } });
  const base = await service(t);
  const r = await w.tool("sessions.accounts.key", { kind: "openai-compatible", key: GOOD, base_url: `${base}/v1`, model: "lab-small", label: "My lab server" });
  assert.equal(r.error, undefined, JSON.stringify(r));
  const fetched = await w.d.registry.call("threads.models-fetch", {}, "module:models");
  assert.equal(fetched.error, undefined, JSON.stringify(fetched.error));
  const row = (fetched.data || []).find((/** @type {any} */ x) => x.provider === "openai-compatible");
  assert.ok(row, JSON.stringify(fetched.data));
  assert.equal(row.ok, true, JSON.stringify(row));
  assert.deepEqual(row.models, [{ id: "lab-small", label: "Lab Small" }, { id: "lab-large" }]);
  assert.ok(!JSON.stringify(fetched).includes(GOOD), "the key is in no answer");
  // the registry looks, and the person's picker (providers.list) lists what the service answered
  const refreshed = await w.tool("models.refresh", {});
  assert.equal(refreshed.error, undefined, JSON.stringify(refreshed.error));
  const listed = await w.tool("models.list", { provider: "openai-compatible" });
  assert.ok(JSON.stringify(listed).includes("lab-small"), `refresh ${JSON.stringify(refreshed.data)} list ${JSON.stringify(listed.data || listed.error).slice(0, 300)}`);
  const providers = (await w.tool("providers.list", {})).data;
  const mine = providers.find((/** @type {any} */ p) => p.id === "openai-compatible");
  assert.ok(mine, JSON.stringify(providers.map((/** @type {any} */ p) => p.id)));
  assert.deepEqual(mine.models.map((/** @type {any} */ m) => m.id).sort(), ["lab-large", "lab-small"], "the picker lists the live list");
  assert.ok(!JSON.stringify(providers).includes(GOOD));
});

test("an OpenRouter account lists OpenRouter's own models, looked at as soon as the account is added, with no eval card for each (#275)", async t => {
  let asked = 0;
  const srv = http.createServer((req, res) => {
    asked++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "acme/small-1", name: "Acme Small", context_length: 8000, pricing: { prompt: "0.000001", completion: "0.000002" } }, { id: "acme/large-2", name: "Acme Large" }] }));
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); }));
  const saved = process.env.VYRE_OPENROUTER_API;
  process.env.VYRE_OPENROUTER_API = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
  t.after(() => { if (saved === undefined) delete process.env.VYRE_OPENROUTER_API; else process.env.VYRE_OPENROUTER_API = saved; });
  const w = await boot(t, { driver: "cli", vault: { "or-key": ["sk", "or", "v1", "test", "1234567890"].join("-") /* built, so the file carries no key-shaped string */ } });
  assert.equal(asked, 0, "nothing is read before an account is added");
  const acct = await w.tool("sessions.accounts.add", { provider: "openrouter", label: "Router", kind: "api-key", vault_item: "or-key" });
  assert.equal(acct.error, undefined, JSON.stringify(acct));
  // no models.refresh here: adding the account is what makes the registry look
  const ids = await until(async () => {
    const l = (await w.tool("models.list", { provider: "openrouter" })).data;
    return l && l.models.length >= 2 ? l.models.map((/** @type {any} */ m) => m.id).sort() : null;
  }, "the registry to look after the account was added");
  assert.deepEqual(ids, ["acme/large-2", "acme/small-1"]);
  const small = (await w.tool("models.get", { id: "openrouter/acme/small-1" })).data;
  assert.deepEqual([small.provider, small.label, small.context, small.price], ["openrouter", "Acme Small", 8000, { in: 1, out: 2 }]);
  const offered = (await w.tool("sessions.accounts.models", { account: acct.data.id })).data;
  assert.deepEqual(offered.models.map((/** @type {any} */ m) => m.id).sort(), ["acme/large-2", "acme/small-1"], "the account offers them");
  const providers = (await w.tool("providers.list", {})).data;
  const or = providers.find((/** @type {any} */ p) => p.id === "openrouter");
  assert.ok(or, JSON.stringify(providers.map((/** @type {any} */ p) => p.id)));
  assert.deepEqual(or.models.map((/** @type {any} */ m) => m.id).sort(), ["acme/large-2", "acme/small-1"], "and the pickers list them");
  assert.deepEqual((await w.tool("models.evals", {})).data.evals, [], "a catalogue model proposes no eval card");
});
