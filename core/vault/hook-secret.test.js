// @ts-check
// hooks.open with no Vault item named: the Vault makes the route's signing secret (vault.make-hook-secret, only for module:hooks), stores it as hooks-<route>, grants it to hooks, and returns the item NAME, never
// the value. Run in a real vyred. The value is read back from the Vault itself, then searched for in every reply, log line and the audit trail. Refusals: a model, a member, a guest, another module, a name outside
// hooks-, an item that already exists. A route that already exists is left as it was. The made secret verifies a signed delivery.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { open } from "../store/index.js";
import { Vault } from "./vault.js";
import { sign, verify } from "../hooks/verify.js";

async function boot(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  /** @type {string[]} */ const logs = [];
  const d = await start({ presence: present, root, log: (/** @type {any} */ l) => logs.push(String(l)) });
  t.after(() => d.stop());
  const reg = (/** @type {string} */ tool, input = {}, caller = "cli") => d.registry.call(tool, input, caller);
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const vault = () => new Vault({ db, dir: path.join(root, "vault"), config: { name: "test-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  return { d, reg, logs, vault };
}

test("hooks.open makes the signing secret in the Vault, grants it to hooks, and the value is in no reply, log or audit line", async t => {
  const { d, reg, logs, vault } = await boot(t);
  const opened = await reg("hooks.open", { name: "orders", verify: { scheme: "hmac-sha256", header: "x-signature" } });
  assert.equal(opened.error, undefined, JSON.stringify(opened));
  assert.equal(opened.data.secret_made, "hooks-orders");
  assert.equal(opened.data.verify.secret, "hooks-orders");
  assert.equal(typeof opened.data.space, "string", "the route records the Space it was opened for");
  const item = (await reg("vault.list")).data.items.find((/** @type {any} */ i) => i.name === "hooks-orders");
  assert.ok(item, "the item is in the Vault");
  assert.deepEqual([...new Set(item.grants.map((/** @type {any} */ g) => g.module))], ["hooks"], "granted to the hooks module and no one else");
  const value = String((await vault().fields(vault().row("hooks-orders"))).value);
  assert.match(value, /^[0-9a-f]{64}$/, "32 random bytes");
  // The canary: the value is nowhere a reply, a log line or the audit trail could show it.
  const places = [opened, await reg("hooks.list"), await reg("hooks.status"), await reg("vault.list"), await reg("vault.audit"), await reg("hooks.close", { name: "orders" })];
  for (const p of places) assert.equal(JSON.stringify(p).includes(value), false, "a reply carries the secret");
  assert.equal(logs.join("\n").includes(value), false, "a log line carries the secret");
  assert.match(places[5].data.secret_kept, /still in the Vault as hooks-orders/, "closing the route keeps the item and says so");
  assert.ok((await reg("vault.list")).data.items.some((/** @type {any} */ i) => i.name === "hooks-orders"), "close does not delete the item");
  // The made secret verifies a signed delivery.
  const body = Buffer.from('{"amount":80}');
  assert.equal(verify({ scheme: "hmac-sha256", header: "x-signature" }, { "x-signature": sign("hmac-sha256", value, body) }, body, value, Date.now()).ok, true);
  assert.equal(d.registry.tools.has("vault.make-hook-secret"), true);
});

test("only module:hooks may ask; a model, a member, a guest, the CLI and another module are refused", async t => {
  const { reg } = await boot(t);
  for (const caller of ["cli", "local", "mcp", "harness", "mcp:agent:kit", "module:threads", "module:sessions", "hook"]) {
    const r = await reg("vault.make-hook-secret", { name: "hooks-x" }, caller);
    assert.ok(r.error, `${caller} was refused: ${JSON.stringify(r)}`);
  }
  assert.equal((await reg("vault.list")).data.items.some((/** @type {any} */ i) => i.name === "hooks-x"), false, "nothing was made");
  const ok = await reg("vault.make-hook-secret", { name: "hooks-x" }, "module:hooks");
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.deepEqual(ok.data, { item: "hooks-x" }, "the item name and nothing else");
});

test("a name outside hooks- is refused, an existing item is never replaced, and a route that exists is left as it was", async t => {
  const { reg, vault } = await boot(t);
  const bad = await reg("vault.make-hook-secret", { name: "ai-key-openai-1" }, "module:hooks");
  assert.match(bad.error && bad.error.message, /named hooks-/);
  assert.equal((await reg("vault.put", { name: "hooks-orders", kind: "secret", value: "person-made-value-1f2e" })).error, undefined);
  const again = await reg("hooks.open", { name: "orders", verify: { scheme: "hmac-sha256", header: "x-signature" } });
  assert.match(again.error && again.error.message, /already in the Vault/);
  assert.equal((await vault().fields(vault().row("hooks-orders"))).value, "person-made-value-1f2e", "the person's item is untouched");
  assert.deepEqual((await reg("hooks.list")).data.routes, [], "no route was opened by the failed call");
  // A named item still works as it did, and an open route is not reopened.
  assert.equal((await reg("vault.put", { name: "northwind-hook", kind: "secret", value: "nw-secret-22aa" })).error, undefined);
  assert.equal((await reg("hooks.open", { name: "northwind", verify: { scheme: "hmac-sha256", header: "x-signature", secret: "northwind-hook" } })).error, undefined);
  const dup = await reg("hooks.open", { name: "northwind", verify: { scheme: "hmac-sha256", header: "x-signature" } });
  assert.match(dup.error && dup.error.message, /already open/);
  assert.equal((await reg("hooks.list")).data.routes.find((/** @type {any} */ r) => r.name === "northwind").verify.secret, "northwind-hook");
});

test("the person sees the secret being made: the presence summary says so, and not when an item is named", async t => {
  const { d } = await boot(t);
  const summary = d.registry.tools.get("hooks.open").presence.summary;
  assert.equal(summary({ name: "orders", verify: { scheme: "hmac-sha256" } }), "Open /hooks/orders to the internet, accepting only deliveries with a valid hmac-sha256 signature; make a signing secret for it in your Vault (hooks-orders) and let the hooks module use it");
  assert.equal(summary({ name: "orders", verify: { scheme: "github", secret: "mine" } }), "Open /hooks/orders to the internet, accepting only deliveries with a valid github signature");
});
