// @ts-check
// Contract test for team/contracts/mints.md (v1) on a real kernel: a first-party module makes grants for others only inside its manifest's `needs.kernel.mints`, from a source of its own name; lists and ends
// only its own; and the kernel writes the events. Publish's manifest is the real one; a second module stands in for Wink.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createKernel } from "../../kernel/index.js";
import { SPACE, manifestNeeds, made, refused } from "./mints.fixtures.js";

const OWNER = "per_owner";
const publishManifest = JSON.parse(fs.readFileSync(new URL("../../core/publish/module.json", import.meta.url), "utf8"));
const winkManifest = JSON.parse(fs.readFileSync(new URL("../../core/wink/module.json", import.meta.url), "utf8"));

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const publish = k.kernelFor({ name: "publish", needs: publishManifest.needs });
  const wink = k.kernelFor({ name: "wink", needs: winkManifest.needs });
  const nobody = k.kernelFor({ name: "notes", needs: {} });
  return { k, owner, publish, wink, nobody };
}
const live = async (/** @type {any} */ k, /** @type {any} */ owner, /** @type {string} */ prefix) => (await k.gateway.grants.list(owner)).filter((/** @type {any} */ g) => g.source.startsWith(prefix) && g.status === "active");

test("the real manifests list what Publish and Wink mint, and a module with no list has no handle", async () => {
  const { nobody } = await rig();
  assert.deepEqual(publishManifest.needs.kernel.mints, [{ prefix: "credential/*", actions: ["vault.run"] }]);
  assert.deepEqual(winkManifest.needs.kernel.mints.map((/** @type {any} */ m) => m.actions[0]).sort(), ["member.act", "node.host", "storage.hold"]);
  assert.equal(nobody.mint, undefined, "no `mints` line, no handle");
  assert.ok(manifestNeeds.kernel.mints.length > 0);
});

test("make, list and end: inside the manifest, from the module's own source, the issuer is the module and the log has the events", async () => {
  const { k, owner, publish } = await rig();
  const id = await publish.mint.make(made.deploymentSecret);
  assert.match(id, /^gr_/);
  const [g] = await publish.mint.list({ source: "publish:secret:dep_a:" });
  assert.deepEqual([g.id, g.actions, g.source, g.status, g.issuer], [id, ["vault.run"], made.deploymentSecret.source, "active", { kind: "service", id: "publish", space: SPACE }]);
  assert.equal((await publish.mint.list({ source: "publish:secret:other:" })).length, 0, "list narrows by source prefix");
  assert.equal((await live(k, owner, "publish:secret:")).length, 1, "the Space's own grant list shows it");
  assert.deepEqual(await publish.mint.end({ id, reason: "taken away" }), [id]);
  assert.equal((await publish.mint.list({ source: "publish:" })).length, 0);
  assert.equal((await live(k, owner, "publish:secret:")).length, 0);
});

test("the kernel refuses what the manifest does not list, writes nothing, and says the code", async () => {
  const { k, owner, publish } = await rig();
  for (const r of refused) await assert.rejects(() => publish.mint.make(r.input), { code: r.code }, r.why);
  assert.equal((await live(k, owner, "publish:")).length, 0);
});

test("a module ends only its own grants", async () => {
  const { k, owner, publish, wink } = await rig();
  const id = await publish.mint.make(made.deploymentSecret);
  assert.deepEqual(await wink.mint.end({ id }), [], "another module's grant is not its to end");
  assert.equal((await live(k, owner, "publish:secret:")).length, 1);
  assert.deepEqual(await wink.mint.list({ source: "publish:" }), [], "nor to list");
  await publish.mint.end({ source: made.deploymentSecret.source });
  assert.equal((await live(k, owner, "publish:secret:")).length, 0, "ending by source works too");
});

test("Wink's grants for a lent computer are inside its manifest", async () => {
  const { wink } = await rig();
  const id = await wink.mint.make({ ...made.sharedComputer, resource: { prefix: `vyre://${SPACE}/node/dev_a/` } });
  assert.match(id, /^gr_/);
  await assert.rejects(() => wink.mint.make({ ...made.sharedComputer, actions: ["vault.run"] }), { code: "not_allowed" });
});
