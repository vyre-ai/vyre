// @ts-check
// Publish's deployment secrets on a REAL kernel: the grants the store adapter makes are accepted by the kernel inside the manifest's `needs.kernel.mints` list, are listed and ended through the handle,
// and the kernel refuses what the manifest does not list.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createKernel } from "../../kernel/index.js";
import { withSecretGrants } from "./grants.js";
import { memoryStore } from "./test-kit.js";

const S = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const manifest = JSON.parse(fs.readFileSync(new URL("../../core/publish/module.json", import.meta.url), "utf8"));

async function rig() {
  const k = await createKernel({ space: S, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9) });
  const h = k.kernelFor({ name: "publish", needs: manifest.needs });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const grants = { list: (/** @type {string} */ source) => h.mint.list({ source }), make: (/** @type {any} */ i) => h.mint.make(i), end: (/** @type {any} */ q) => h.mint.end(q) };
  const raw = memoryStore();
  return { k, h, owner, raw, store: withSecretGrants(raw, grants, S) };
}
const secret = (/** @type {string} */ name, use = ["runtime"]) => ({ name, ref: `vault://harlow/${name.toLowerCase()}`, class: "secret", use, granted_by: OWNER, granted_at: 1 });

test("the manifest lists the one thing Publish mints: vault.run on a credential", () => {
  assert.deepEqual(manifest.needs.kernel.mints, [{ prefix: "credential/*", actions: ["vault.run"] }]);
});

test("a deployment's secrets become kernel grants, show in the Space's grant list, and go when the secret or the deployment goes", async () => {
  const { store, owner, k, raw } = await rig();
  await store.put("deployments", "dep_a", { id: "dep_a", name: "site", secrets: [secret("STRIPE_KEY", ["build", "runtime"]), secret("MAIL_KEY")] });
  const made = (await k.gateway.grants.list(owner)).filter((/** @type {any} */ g) => g.source.startsWith("publish:secret:") && g.status === "active");
  assert.equal(made.length, 2);
  assert.ok(made.every((/** @type {any} */ g) => g.actions.join() === "vault.run" && g.subject.actor.id === "deployment-dep_a" && g.issuer.id === "publish"));
  assert.equal("secrets" in (await raw.get("deployments", "dep_a")), false);
  assert.deepEqual((await store.get("deployments", "dep_a")).secrets.map((/** @type {any} */ s) => s.name).sort(), ["MAIL_KEY", "STRIPE_KEY"]);
  const d = await store.get("deployments", "dep_a");
  await store.put("deployments", "dep_a", { ...d, secrets: d.secrets.filter((/** @type {any} */ s) => s.name !== "MAIL_KEY") });
  assert.deepEqual((await store.get("deployments", "dep_a")).secrets.map((/** @type {any} */ s) => s.name), ["STRIPE_KEY"]);
  await store.delete("deployments", "dep_a");
  assert.equal((await k.gateway.grants.list(owner)).filter((/** @type {any} */ g) => g.source.startsWith("publish:secret:") && g.status === "active").length, 0);
});

test("the kernel refuses Publish a grant its manifest does not list", async () => {
  const { h } = await rig();
  const subject = { kind: "actor", actor: { kind: "service", id: "deployment-dep_a", space: S } };
  await assert.rejects(() => h.mint.make({ subject, actions: ["vault.reveal"], resource: { prefix: `vyre://${S}/credential/x` }, source: "publish:secret:dep_a:X:secret:runtime" }), { code: "not_allowed" });
  await assert.rejects(() => h.mint.make({ subject, actions: ["vault.run"], resource: { prefix: `vyre://${S}/contact/x` }, source: "publish:secret:dep_a:X:secret:runtime" }), { code: "not_allowed" });
  await assert.rejects(() => h.mint.make({ subject, actions: ["vault.run"], resource: { prefix: `vyre://${S}/credential/x` }, source: "wink:W1" }), { code: "not_allowed" });
});
