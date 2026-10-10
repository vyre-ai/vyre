// @ts-check
// Vyre Computer on a REAL vyred with two people: the Macs paired to this box are the owner's. The owner's session sees them as computers; another member's session sees the cloud
// computer only and, naming the owner's Mac, is not sent to it (audit G05: every paired Mac was a target for every caller).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { asOwner, tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("the owner's paired Mac is a computer for the owner and for nobody else: a member's session sees the cloud only and cannot be sent to the Mac", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false } }));
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "");
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const tokenOf = async (/** @type {any} */ chain) => (await d.kernel.surfaces.open(chain, {})).token;
  const MEMBER = "per_" + "m".repeat(26);
  await d.kernel.gateway.grants.setRole(admin, { person: MEMBER, role: "member" }, { presence: { method: "stand-in" } });
  const member = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-m", person: MEMBER, path: "direct", session: "s2" });
  // two Macs paired to this box (approved at the box by its owner)
  const db = d.registry.deps.db;
  for (const [id, name] of [["mac-1", "Alex's MacBook"], ["mac-2", "Office Mac mini"]]) db.prepare("INSERT INTO link_peers (id, name, login, node, stable_id, key_hash, paired_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'mac')").run(id, name, "alex@example.com", null, `stable-${id}`, `hash-${id}`, Date.now());
  const names = async (/** @type {any} */ chain) => ((await d.registry.call("computer.targets", {}, "cli", { token: await tokenOf(chain) })).data.computers || []).map((/** @type {any} */ c) => c.name);
  const ownerSees = await names(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" }));
  assert.deepEqual(ownerSees, ["Cloud computer", "Alex's MacBook", "Office Mac mini"], "the owner's session sees the cloud computer and each paired Mac");
  assert.deepEqual(await names(member), ["Cloud computer"], "a member's session sees the cloud computer only");
  const use = await d.registry.call("computer.use", { do: "look", on: "Office Mac mini" }, "cli", { token: await tokenOf(member) });
  assert.ok(!use.error || use.error.code !== "offline", `the member was not sent to the Mac: ${JSON.stringify(use).slice(0, 300)}`);
  assert.ok(!(use.data && use.data.computer === "Office Mac mini"), "and the Mac was not the one picked");
});
