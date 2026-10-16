// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { x25519Pair } from "./wrap.js";
import { create, grant, put, list, rotate, resume, lend, externalMcp, openAsMember, status, rotateOnRemove, pumpRetries, needsYou, cancelRetries, attention } from "./space-vault.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sv-"));
const SECRET = "vyre-space-secret-9f3a7c";

test("space vault: rotation survives a crash before commit and a crash after commit", () => {
  const dir = scratch();
  const alice = x25519Pair();
  const bob = x25519Pair();
  create(dir);
  grant(dir, "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", alice.pub);
  grant(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", bob.pub);
  put(dir, { id: "stripe", name: "Stripe", value: SECRET });
  assert.equal(openAsMember(dir, "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", alice.priv, "stripe"), SECRET);
  assert.throws(() => rotate(dir, { remove: ["per_aaaaaaaaaaaaaaaaaaaaaaaaaa"], crash: (at) => { if (at === "before-commit") throw new Error("crash"); } }), /crash/);
  assert.equal(status(dir).generation, 1);
  assert.equal(openAsMember(dir, "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", alice.priv, "stripe"), SECRET);
  assert.equal(resume(dir).discarded, 2);
  assert.equal(openAsMember(dir, "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", alice.priv, "stripe"), SECRET);
  assert.throws(() => rotate(dir, { remove: ["per_aaaaaaaaaaaaaaaaaaaaaaaaaa"], crash: (at) => { if (at === "after-commit") throw new Error("crash"); } }), /crash/);
  assert.equal(status(dir).generation, 2);
  assert.throws(() => openAsMember(dir, "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", alice.priv, "stripe"), (e) => e.code === "not_found");
  assert.equal(openAsMember(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", bob.priv, "stripe"), SECRET);
  const resumed = resume(dir);
  assert.equal(resumed.cleaned, 1);
  assert.equal(status(dir).generation, 2);
  assert.equal(fs.existsSync(path.join(dir, "gen", "1")), false);
  assert.equal(openAsMember(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", bob.priv, "stripe"), SECRET);
  assert.deepEqual(list(dir).items, [{ id: "stripe", name: "Stripe" }]);
  assert.equal(JSON.stringify(list(dir)).includes(SECRET), false);
});

test("an external MCP agent uses a space vault credential and never receives the value", async () => {
  const dir = scratch();
  create(dir);
  put(dir, { id: "stripe", name: "Stripe", value: SECRET });
  const seen = [];
  const mcp = await externalMcp(dir, {
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "vault_space_request", arguments: { id: "stripe", url: "https://example.com/charge", method: "POST" } },
  }, async (req) => {
    seen.push(req);
    return { status: 201, body: JSON.stringify({ id: "ch_1", ok: true }) };
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(seen[0].url, "https://example.com/charge");
  const text = JSON.stringify(mcp);
  assert.equal(text.includes(SECRET), false);
  assert.match(text, /ch_1/);
  assert.equal(mcp.result.isError, false);
  const echoed = await lend(dir, {
    id: "stripe",
    request: { url: "https://example.com/echo", method: "POST" },
    transport: async () => ({ status: 200, body: { echoed: SECRET } }),
  });
  assert.equal(JSON.stringify(echoed).includes(SECRET), false);
  assert.equal(echoed.body.echoed, "[redacted]");
  assert.equal(echoed.ok, true);
});

test("a failed rotation on member removal queues a retry and flags Needs you", () => {
  const root = scratch();
  const dir = path.join(root, "spc_test_juniper");
  const bob = x25519Pair();
  create(dir);
  grant(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", bob.pub);
  put(dir, { id: "stripe", name: "Stripe", value: SECRET });
  const wraps = fs.readFileSync(path.join(dir, "gen", "1", "wraps.json"));
  fs.writeFileSync(path.join(dir, "gen", "1", "wraps.json"), "{}\n");
  const failed = rotateOnRemove(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(failed.needsYou, true);
  assert.equal(failed.queued, true);
  const title = String(needsYou(dir)?.title);
  assert.match(title, /did not rotate/);
  assert.equal(status(dir).needsYou?.title, title);
  assert.equal(attention(root).items[0].title, title);
  assert.equal(JSON.stringify(attention(root)).includes(SECRET), false);
  assert.equal(pumpRetries(root).waiting, 1, "still broken, still flagged");
  fs.writeFileSync(path.join(dir, "gen", "1", "wraps.json"), wraps);
  const done = pumpRetries(root);
  assert.equal(done.waiting, 0);
  assert.equal(needsYou(dir), null);
  assert.equal(status(dir).generation, 2);
  assert.equal(status(dir).needsYou, undefined);
  assert.throws(() => openAsMember(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", bob.priv, "stripe"), (e) => /** @type {any} */ (e).code === "not_found");
  assert.deepEqual(list(dir).items, [{ id: "stripe", name: "Stripe" }]);
  assert.equal(attention(root).items.length, 0);
  cancelRetries();
});
