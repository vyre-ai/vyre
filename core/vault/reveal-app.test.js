// @ts-check
// What the web app's Reveal button does (apps/app/src/state/vault.ts: `vault.reveal { name, field }`), against a real vyred with the kernel on: the owner's signed-in device
// gets the value after the person's yes (presence), a model's label never does (the presence fixture here says yes to every proof, so the no-proof refusal is core/vault/presence.test.js's).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

test("vault.reveal from the app: the owner's signed-in device sees the value after the yes; a model's label never does", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  assert.equal((await d.registry.call("vault.put", { name: "harlow-login", value: "s3cret-value" }, "local")).error, undefined);
  const id = "aaaaaaaaaaaaaaaa";
  d.registry.deps.db.prepare("INSERT OR IGNORE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'phone', 'p', 1, 'app', 0, NULL)").run(id);
  const facts = { kind: "device", device_key_id: id, person: d.kernel.id.owner, path: "relay", session: "ps1" };
  const signed = { person: { id: "ps1" }, kernelFacts: facts };
  const shown = await d.registry.call("vault.reveal", { name: "harlow-login", field: "value" }, `device:${id}`, { ...signed, presence: { method: "passkey", keyId: null } });
  assert.ok(!shown.error, JSON.stringify(shown));
  assert.equal(shown.data.value, "s3cret-value");
  for (const caller of ["mcp", "mcp:agent:kit", "harness"]) {
    const r = await d.registry.call("vault.reveal", { name: "harlow-login", field: "value" }, caller, { presence: { method: "passkey", keyId: null } });
    assert.ok(r.error && !JSON.stringify(r).includes("s3cret-value"), `${caller}: ${JSON.stringify(r)}`);
  }
});
