import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeFacts, sampleCall } from "./webhook-model.js";

const hooks = (o = {}) => ({ enabled: true, listening: true, routes: [{ name: "orders", scheme: "hmac-sha256", header: "x-signature", secret: "orders-hook" }], public: { available: true, base: "https://box.example" }, urls: { orders: "https://box.example/hooks/orders" }, ...o });

test("a route reachable from the internet shows its address, header and Vault item", () => {
  const f = routeFacts(hooks(), "orders");
  assert.equal(f.url, "https://box.example/hooks/orders");
  assert.equal(f.header, "x-signature");
  assert.equal(f.secret, "orders-hook");
  assert.equal(f.next, "none");
});

test("a route that cannot be reached says why, in plain words, and what to do", () => {
  const off = routeFacts(hooks({ enabled: false, listening: false, public: { available: false, why: "x" }, urls: { orders: null } }), "orders");
  assert.equal(off.next, "enable");
  assert.match(off.line, /listener is off/);
  const noAddr = routeFacts(hooks({ public: { available: false, why: "the box has no public address yet" }, urls: { orders: null } }), "orders");
  assert.equal(noAddr.next, "wait");
  assert.equal(noAddr.line, "the box has no public address yet");
  assert.equal(routeFacts(hooks(), "nope").next, "open");
  assert.equal(routeFacts(null, "x").next, "none");
});

test("the sample call signs with the Vault item's value, which is never in the text", () => {
  const c = sampleCall("https://box.example/hooks/orders", "hmac-sha256", "x-signature");
  assert.match(c, /curl -X POST 'https:\/\/box.example\/hooks\/orders'/);
  assert.match(c, /x-signature: \$\(printf/);
  assert.match(c, /SECRET='<the value of the Vault item>'/);
  assert.match(sampleCall("", "github", ""), /X-Hub-Signature-256: sha256=/);
  assert.match(sampleCall("u", "stripe", ""), /Stripe CLI/);
});

test("the webhook fields name the Vault item and offer to add it there", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./WebhookFields.tsx", import.meta.url), "utf8");
  assert.match(src, /Add the secret in the Vault/);
  assert.match(src, /openVault/);
  assert.doesNotMatch(src, /vault\.generate|secret_once/, "the editor never makes or shows a secret itself");
});
