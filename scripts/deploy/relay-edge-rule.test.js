import test from "node:test";
import assert from "node:assert/strict";
import { edgeRule, mergeRules, upsert } from "./relay-edge-rule.mjs";

const ZONE = "a".repeat(32);

test("edge rule: it counts per address on exactly the two routes, and merges without touching other rules", () => {
  const r = edgeRule();
  assert.ok(r.ratelimit.characteristics.includes("ip.src"), "per address, never one shared budget");
  assert.equal(r.action, "block");
  assert.match(r.expression, /relay\.vyre\.run/);
  assert.match(r.expression, /\/v1\/pair/);
  assert.match(r.expression, /\/v1\/setup\/mbx/);
  const other = { id: "x", ref: "someone-else", expression: "true", action: "block", ratelimit: { period: 10 } };
  const merged = mergeRules([other, { ...r, id: "old", ratelimit: { ...r.ratelimit, requests_per_period: 5 } }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].ref, "someone-else");
  assert.equal(merged[0].id, undefined, "server fields are not sent back");
  assert.equal(merged[1].ratelimit.requests_per_period, 50, "ours replaced its older copy");
});

test("edge rule: it reads, then PUTs, and says which scope is missing when Cloudflare refuses", async () => {
  const calls = [];
  const ok = async (url, init = {}) => { calls.push([init.method || "GET", url]); return init.method === "PUT" ? { ok: true, status: 200, json: async () => ({}) } : { status: 404, ok: false, json: async () => ({}) }; };
  assert.deepEqual(await upsert({ token: "t", zone: ZONE, fetch: /** @type {any} */ (ok) }), { rules: 1, dryRun: false, refs: ["vyre-relay-edge-cap"] });
  assert.deepEqual(calls.map(c => c[0]), ["GET", "PUT"]);
  assert.match(calls[0][1], /rulesets\/phases\/http_ratelimit\/entrypoint$/);
  calls.length = 0;
  assert.equal((await upsert({ token: "t", zone: ZONE, dryRun: true, fetch: /** @type {any} */ (ok) })).dryRun, true);
  assert.deepEqual(calls.map(c => c[0]), ["GET"], "a dry run writes nothing");
  const refused = async () => ({ status: 403, ok: false, json: async () => ({}) });
  await assert.rejects(upsert({ token: "t", zone: ZONE, fetch: /** @type {any} */ (refused) }), /Zone WAF > Edit/);
  const full = async (url, init = {}) => (init.method === "PUT" ? { ok: false, status: 400, json: async () => ({}) } : { status: 200, ok: true, json: async () => ({ result: { rules: [{ ref: "other", expression: "true", action: "block" }] } }) });
  await assert.rejects(upsert({ token: "t", zone: ZONE, fetch: /** @type {any} */ (full) }), /only one rate-limiting rule/);
  const odd = async () => ({ status: 200, ok: true, json: async () => ({ result: {} }) });
  await assert.rejects(upsert({ token: "t", zone: ZONE, fetch: /** @type {any} */ (odd) }), /no rules list/);
  await assert.rejects(upsert({ token: "", zone: ZONE }), /zone id/);
});
