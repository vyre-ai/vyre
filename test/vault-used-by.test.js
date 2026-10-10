// @ts-check
// R031-70, "Used by", on a real daemon: one list of everything that uses a credential, from the grants the person gave, the Connections that hold it, Publish's kernel grants for sites and the records it is
// linked to; each user says what a new value does to it. Names and kinds only: the value is in no answer. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, writeModule } from "./helpers.js";
import { credentialUrn } from "../kernel/contracts/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const manifest = JSON.parse(fs.readFileSync(new URL("../core/publish/module.json", import.meta.url), "utf8"));
const KEY = "fixture-deepgram-key-0123456789abcdef0123456789";
const PW = "fixture-mailbox-pass-0123456789abcdef";

test("a credential lists every user with what a new value does to each, and no value", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  // postbox stands in for one of Vyre's own modules (mail): it declares a mailbox need and loads as first party
  writeModule(path.join(root, "modules"), "postbox", { does: { tools: ["postbox.ping"] }, needs: { credentials: [{ id: "account", kind: "env-set", provider: "imap-smtp", purpose: "a mailbox", multiple: true }] } },
    `export default { async start(ctx) { ctx.tool("postbox.ping", { input: { type: "object", properties: {} }, run: async () => ({ ok: true }) }); return { async stop() {} }; } };`);
  const d = await start({ root, presence: present, firstPartyRoots: [path.join(root, "modules")], log: () => {} });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(owner, {})).token });
  const space = d.kernel.id.space;

  assert.ok(!(await as("vault.put", { name: "deepgram", kind: "secret", fields: { value: KEY } })).error);
  assert.deepEqual((await as("vault.used-by", { item: "deepgram" })).data.users, [], "nothing uses a new credential");

  // a module the person gave it to
  assert.ok(!(await as("vault.grant", { name: "deepgram", module: "voice" })).error);
  // a site, on Publish's kernel grant (a runtime secret restarts the site's server; a build one is read at the next build)
  const publish = d.kernel.kernelFor({ name: "publish", needs: manifest.needs });
  const give = (/** @type {string} */ dep, /** @type {string} */ use) => publish.mint.make({ subject: { kind: "actor", actor: { kind: "service", id: `deployment-${dep}`, space } }, actions: ["vault.run"], resource: { prefix: credentialUrn(space, "deepgram") }, source: `publish:secret:${dep}:DEEPGRAM_KEY:secret:${use}:per_owner`, reason: "granted by the owner" });
  await give("dep_run", "runtime"); await give("dep_build", "build");
  // a record it is linked to
  const proj = await d.kernel.gateway.records.create(owner, "project", { name: "Northwind", slug: "northwind" });
  assert.ok(!(await as("vault.link", { item: "deepgram", to: proj.urn })).error);

  const r = await as("vault.used-by", { item: "deepgram" });
  assert.ok(!r.error, JSON.stringify(r.error));
  const by = (/** @type {string} */ kind) => r.data.users.filter((/** @type {any} */ u) => u.kind === kind);
  assert.equal(by("module")[0].label, "Vyre's voice module");
  assert.match(by("module")[0].renews, /next time/);
  assert.deepEqual(by("deployment").map((/** @type {any} */ u) => [u.id, u.restarts]).sort(), [["dep_build", false], ["dep_run", true]]);
  assert.match(by("deployment").find((/** @type {any} */ u) => u.id === "dep_run").renews, /server restarts/);
  assert.match(by("deployment").find((/** @type {any} */ u) => u.id === "dep_build").renews, /next build/);
  assert.equal(by("record")[0].id, proj.urn);
  assert.equal(r.data.restarts, 1, "one user restarts when a new value is stored");
  assert.equal(r.data.count, 4);
  assert.ok(!JSON.stringify(r).includes(KEY), "names and kinds only");

  // a Connection that holds an item lists it as a user of that item
  const con = await as("vault.connect", { module: "postbox", need: "account", label: "northwind", fields: { imap_host: "imap.northwind.test", imap_port: "993", smtp_host: "smtp.northwind.test", smtp_port: "465", username: "kit", password: PW, from: "Kit@Northwind.test", security: "tls" } });
  assert.ok(!con.error, JSON.stringify(con.error));
  const held = d.registry.deps.db.prepare("SELECT items FROM vault_connections").all().flatMap((/** @type {any} */ c) => JSON.parse(c.items));
  assert.ok(held.length > 0);
  const mailUsers = (await as("vault.used-by", { item: held[0] })).data.users;
  assert.ok(mailUsers.some((/** @type {any} */ u) => u.kind === "connection"), JSON.stringify(mailUsers));
  assert.ok(!JSON.stringify(mailUsers).includes(PW));

  // taking a grant away takes the user off the list; a missing item is a plain refusal
  await publish.mint.end({ source: "publish:secret:dep_run:DEEPGRAM_KEY:secret:runtime:per_owner" });
  assert.equal((await as("vault.used-by", { item: "deepgram" })).data.restarts, 0);
  assert.equal((await as("vault.used-by", { item: "nope" })).error.code, "not_found");
  // a model caller does not get the list
  assert.equal((await d.registry.call("vault.used-by", { item: "deepgram" }, "mcp")).error.code, "denied");
});
