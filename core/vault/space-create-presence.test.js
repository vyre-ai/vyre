// @ts-check
// A space's own vault is made only with the person's approval. A paired web device whose key is a software key cannot give it on a release server, so the first run leaves the vault for later:
// the server must still refuse vault.space.create to that session after the space is online, and make it once the approval is real.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

const SPACE = "spc_aaaaaaaaaa";

async function boot(/** @type {any} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [], vault: { keystore: "file", reminders: false }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const pres = {
    deny: true,
    required: (/** @type {any} */ _tool, /** @type {any} */ def) => Boolean(def && def.presence),
    verify: async () => (pres.deny ? { ok: false, code: "presence_required", message: "prove presence" } : { ok: true, method: "test" }),
    challenge: async () => ({ error: { code: "bad_input", message: "no challenge in this test" } }),
  };
  const d = await start({ root, presence: pres, log: () => {} });
  t.after(() => d.stop());
  return { d, pres };
}

test("the server refuses vault.space.create to a session that cannot give presence, leaves no vault, and makes it when the approval is real", async (t) => {
  const { d, pres } = await boot(t);
  const asDevice = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", {});
  const refused = await asDevice("vault.space.create", { space: SPACE });
  assert.equal(refused.error && refused.error.code, "presence_required");
  const none = await asDevice("vault.space.status", { space: SPACE });
  assert.equal(none.data && none.data.exists, false, "no vault was made by the refused call");
  assert.deepEqual((await asDevice("vault.space.list", { space: SPACE })).data, { items: [] }, "a space with no vault lists nothing");
  pres.deny = false;
  const made = await d.registry.call("vault.space.create", { space: SPACE }, "cli", { proof: { method: "tty", id: "t", code: "C" } });
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.equal((await asDevice("vault.space.status", { space: SPACE })).data.exists, true);
});

test("vault.space.put in the server's own space: refused without approval and nothing is made; with the approval it makes the key and stores the item; another space id still makes nothing", async (t) => {
  const { d, pres } = await boot(t);
  const own = String(d.registry.deps.homeSpace);
  const item = { id: "stripe", name: "Stripe key", value: "vyre-test-secret-77", hosts: ["api.stripe.com"] };
  const refused = await d.registry.call("vault.space.put", { space: own, ...item }, "cli", {});
  assert.equal(refused.error && refused.error.code, "presence_required");
  assert.equal((await d.registry.call("vault.space.status", { space: own }, "cli", {})).data.exists, false, "a refused put makes no key");
  pres.deny = false;
  const proof = { proof: { method: "tty", id: "t", code: "C" } };
  const stored = await d.registry.call("vault.space.put", { space: own, ...item }, "cli", proof);
  assert.ok(!stored.error, JSON.stringify(stored.error));
  assert.equal((await d.registry.call("vault.space.status", { space: own }, "cli", {})).data.exists, true);
  assert.deepEqual((await d.registry.call("vault.space.list", { space: own }, "cli", {})).data.items.map((/** @type {any} */ i) => i.id), ["stripe"]);
  const other = "spc_bbbbbbbbbb";
  const elsewhere = await d.registry.call("vault.space.put", { space: other, ...item }, "cli", proof);
  assert.equal(elsewhere.error && elsewhere.error.code, "not_found");
  assert.equal((await d.registry.call("vault.space.status", { space: other }, "cli", {})).data.exists, false);
});
