// @ts-check
// R031-71 on a real daemon: a login linked to a project is the project record's own link (its `credentials` field, the same mechanism every record link uses), the project's timeline says how the login was
// used, and neither the record, the link nor the timeline ever holds the login. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { credentialUrn } from "../kernel/contracts/index.js";
import { vaultFixtures as F } from "./contracts/vault.fixtures.js";
import { matches } from "./contracts/shape.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const PASSWORD = "fixture-portal-password-0123456789abcdef";

async function world(/** @type {import("node:test").TestContext} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(owner, {})).token });
  const as = async (/** @type {string} */ tool, /** @type {any} */ input, caller = "cli") => d.registry.call(tool, input, caller, await meta());
  const proj = await d.kernel.gateway.records.create(owner, "project", { name: "Northwind", slug: "northwind" });
  assert.ok(!(await as("vault.put", { name: "portal-login", kind: "login", fields: { username: "dana@northwind.test", password: PASSWORD }, url: "https://portal.northwind.test/login", hosts: ["https://portal.northwind.test"] })).error);
  assert.ok(!(await as("vault.grant", { name: "portal-login", module: "voice" })).error);
  const use = async () => (await d.registry.call("vault.release", { name: "portal-login", field: "password" }, "module:voice", { door: true })).data.value;
  return { d, owner, as, proj, use, space: d.kernel.id.space };
}

test("link a login to a project, use it, and the project's timeline says so without the login; the link is the record's own", { timeout: 180_000 }, async t => {
  const { d, owner, as, proj, use, space } = await world(t);
  assert.equal(await use(), PASSWORD, "used before the link: that use is not the project's");
  const linked = await as("vault.link", { item: "portal-login", to: proj.urn });
  assert.ok(!linked.error, JSON.stringify(linked));
  matches(linked.data, { linked: { item: "portal-login", to: proj.urn } }, "link");
  const rec = await d.kernel.gateway.records.get(owner, "project", proj.id);
  assert.deepEqual(rec.data.credentials, [{ urn: credentialUrn(space, "portal-login") }], "the record's own link field holds the credential's address");
  assert.equal(await use(), PASSWORD);

  const tl = await as("work.timeline", { record: proj.urn });
  assert.ok(!tl.error, JSON.stringify(tl));
  const uses = tl.data.entries.filter((/** @type {any} */ e) => e.type === "vault-use");
  assert.ok(uses.length >= 1);
  assert.match(uses[0].line, /^portal-login was used by Vyre's voice module$/);
  matches((await as("vault.uses.for", { urn: proj.urn }, "module:work")).data, F.usesFor, "uses.for");
  const both = await as("vault.links", { to: proj.urn });
  matches(both.data, { links: [{ item: "portal-login", to: proj.urn }] }, "links");
  assert.deepEqual((await as("vault.links", { item: "portal-login" })).data.links, [{ item: "portal-login", to: proj.urn }], "the other way: the records that use it");
  assert.ok(!JSON.stringify([tl.data, both.data, rec]).includes(PASSWORD), "the login is on no record, no link and no timeline");

  assert.deepEqual((await as("vault.unlink", { item: "portal-login", to: proj.urn })).data, { unlinked: { item: "portal-login", to: proj.urn } });
  assert.equal((await as("vault.unlink", { item: "portal-login", to: proj.urn })).error.code, "not_found");
  assert.equal((await as("work.timeline", { record: proj.urn })).data.entries.filter((/** @type {any} */ e) => e.type === "vault-use").length, 0);
});

test("a record whose type has no place for logins says so; a login that is deleted drops out of every answer; a model cannot link", { timeout: 180_000 }, async t => {
  const { d, owner, as, proj, use } = await world(t);
  const contact = await d.kernel.gateway.records.create(owner, "contact", { name: "Dana Pierce" });
  const no = await as("vault.link", { item: "portal-login", to: contact.urn });
  assert.match(no.error.message, /no place for logins yet/);
  assert.ok(!(await as("vault.link", { item: "portal-login", to: proj.urn })).error);
  await use();
  assert.ok(!(await as("vault.delete", { name: "portal-login" })).error);
  assert.deepEqual((await as("vault.links", { to: proj.urn })).data.links, [], "a deleted login is no one's link");
  assert.equal((await as("work.timeline", { record: proj.urn })).data.entries.filter((/** @type {any} */ e) => e.type === "vault-use").length, 0);
  for (const who of ["mcp", "harness", "module:notes"]) assert.equal((await d.registry.call("vault.link", { item: "portal-login", to: proj.urn }, who)).error.code, "denied", who);
});
