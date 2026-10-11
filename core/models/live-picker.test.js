// @ts-check
// The model picker reads the LIVE list (0.3.3 G13): a real vyred, a real API-key account on a service of its own, and the registry's refresh asks that service through the inference door; what the person's
// picker lists is what the service answered (ids and labels), and the key is in no answer.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { boot } from "../sessions/testing/boot.js";
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
