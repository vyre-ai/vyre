// @ts-check
// R031-71 on a real daemon: a login linked to a client shows on the client's timeline as a line about its use, and neither the record nor the timeline ever holds the login. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const PASSWORD = "fixture-portal-password-0123456789abcdef";

test("link a login to a client, use it, and the client's timeline says so without the login", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(owner, {})).token });
  const proj = await d.kernel.gateway.records.create(owner, "project", { name: "Northwind", slug: "northwind" });
  const cli = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", {});
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", await meta());

  assert.ok(!(await cli("vault.put", { name: "portal-login", kind: "login", fields: { username: "dana@northwind.test", password: PASSWORD }, url: "https://portal.northwind.test/login", hosts: ["https://portal.northwind.test"] })).error);
  assert.ok(!(await cli("vault.grant", { name: "portal-login", module: "voice" })).error);
  assert.equal((await d.registry.call("vault.release", { name: "portal-login", field: "password" }, "module:voice", { door: true })).data.value, PASSWORD, "the login is used before it is linked: that use is not the record's");
  const linked = await cli("vault.link", { item: "portal-login", to: proj.urn });
  assert.deepEqual(linked.data, { linked: { item: "portal-login", to: proj.urn } }, JSON.stringify(linked));
  assert.equal((await d.registry.call("vault.release", { name: "portal-login", field: "password" }, "module:voice", { door: true })).data.value, PASSWORD);

  const tl = await asOwner("work.timeline", { record: proj.urn });
  assert.ok(!tl.error, JSON.stringify(tl));
  const uses = tl.data.entries.filter((/** @type {any} */ e) => e.type === "vault-use");
  assert.ok(uses.length >= 1, JSON.stringify(tl.data.entries.map((/** @type {any} */ e) => e.type)));
  assert.match(uses[0].line, /^portal-login was used by Vyre's voice module$/);
  assert.equal(uses[0].title, "portal-login");
  assert.ok(!JSON.stringify([tl.data, await cli("vault.links", { to: proj.urn }), await d.kernel.gateway.records.get(owner, "project", proj.id)]).includes(PASSWORD), "the login is on no record, no link and no timeline");
  assert.deepEqual((await cli("vault.links", { to: proj.urn })).data.links.map((/** @type {any} */ l) => l.item), ["portal-login"]);

  // someone who cannot read the record is not told what was used on it; deleting the login takes the lines away
  assert.ok(!(await cli("vault.delete", { name: "portal-login" })).error);
  const after = await asOwner("work.timeline", { record: proj.urn });
  assert.equal(after.data.entries.filter((/** @type {any} */ e) => e.type === "vault-use").length, 0);
});
