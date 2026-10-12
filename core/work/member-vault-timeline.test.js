// @ts-check
// A teammate's view of a project's story carries no names of vault items used on it: measured on the member door's own row (work.timeline under her chain, run by the work module), where a member's app reads it. The owner's story of the same project does. Run it on a test box, never on a personal computer.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { createMemberTools } from "./member-tools.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";

test("work.timeline on the member door: the owner's story of a project lists the vault items used on it, the member's does not", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, space = d.kernel.id.space;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: ANA, role: "member" }, { presence: { op: "x", fields: {}, n: 2 } });
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}, caller = "cli") => d.registry.call(tool, input, caller, { token: (await d.kernel.surfaces.open(ownerChain, {})).token });
  const svc = createMemberTools({ space, kernel: d.kernel, registry: d.registry }).work;
  const anaChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-ana", person: ANA, path: "relay" });
  const made = await svc["project-create"](anaChain, { name: "Ana's matter" });
  const urn = String(made.project);
  assert.ok(!(await as("vault.put", { name: "portal-login", kind: "login", fields: { username: "dana@x.test", password: "fixture-portal-password-0123456789abcdef" }, url: "https://portal.x.test/login", hosts: ["https://portal.x.test"] })).error);
  const gr = await as("vault.grant", { name: "portal-login", module: "voice" });
  assert.ok(!gr.error, JSON.stringify(gr.error));
  const linked = await as("vault.link", { item: "portal-login", to: urn });
  assert.ok(!linked.error, JSON.stringify(linked));
  assert.equal((await d.registry.call("vault.release", { name: "portal-login", field: "password" }, "module:voice", { door: true })).data.value.length > 0, true);
  const kinds = (/** @type {any} */ es) => (es || []).map((/** @type {any} */ e) => e.type);
  const ownersStory = await as("work.timeline", { record: urn });
  assert.ok(kinds(ownersStory.data && ownersStory.data.entries).includes("vault-use"), "the owner's story lists the use: " + JSON.stringify(ownersStory).slice(0, 200));
  const hers = await svc.timeline(anaChain, { project: made.slug });
  assert.ok(!kinds(hers.entries).includes("vault-use"), "hers does not: " + JSON.stringify(kinds(hers.entries)));
});
