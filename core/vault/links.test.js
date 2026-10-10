// @ts-check
// A credential linked to a record (R031-71): the link is a pair of names, the uses come from the audit log, and nothing here holds or shows a value. Deleting the item takes its links.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { byWords, LINKED_URN } from "./links.js";
import { SCRATCH } from "../../test/scratch.mjs";

const CLIENT = "vyre://spc_aaaaaaaaaaaa/client/0194c2a1-7b3e-4c1d-9a55-3f2b8e6d7c10";
const MATTER = "vyre://spc_aaaaaaaaaaaa/matter/0194c2a1-7b3e-4c1d-9a55-3f2b8e6d7c11";
const fake = (/** @type {string} */ label) => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

async function mk(/** @type {import("node:test").TestContext} */ t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-links-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const events = /** @type {any[]} */ ([]);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const password = fake("password");
  await v.put({ name: "portal-login", kind: "login", fields: { username: "dana@harlow.test", password }, url: "https://portal.example.test/login", hosts: ["https://portal.example.test"] }, "cli");
  return { v, events, password };
}

test("link, list both ways, unlink: names and addresses only, with an event and an audit line", async t => {
  const { v, events, password } = await mk(t);
  const r = v.links.link({ item: "portal-login", to: CLIENT }, "cli");
  assert.deepEqual(r, { linked: { item: "portal-login", to: CLIENT } });
  v.links.link({ item: "portal-login", to: CLIENT }, "cli"); // again: the same link
  v.links.link({ item: "portal-login", to: MATTER }, "cli");
  assert.deepEqual(v.links.list({ item: "portal-login" }).links.map(l => l.to).sort(), [CLIENT, MATTER].sort());
  assert.deepEqual(v.links.list({ to: CLIENT }).links.map(l => l.item), ["portal-login"]);
  assert.deepEqual(events.filter(e => e.type === "vault.linked").map(e => e.p), [{ name: "portal-login", to: CLIENT }, { name: "portal-login", to: CLIENT }, { name: "portal-login", to: MATTER }]);
  assert.ok(!JSON.stringify([v.links.list(), events]).includes(password));
  v.links.unlink({ item: "portal-login", to: MATTER }, "cli");
  assert.deepEqual(v.links.list({ item: "portal-login" }).links.map(l => l.to), [CLIENT]);
  assert.throws(() => v.links.unlink({ item: "portal-login", to: MATTER }, "cli"), { code: "not_found" });
  const audit = /** @type {any[]} */ (v.db.prepare("SELECT action, name, why FROM vault_audit WHERE action IN ('link','unlink')").all());
  assert.ok(audit.some(a => a.action === "link" && a.name === "portal-login" && a.why === "client/0194c2a1-7b3e-4c1d-9a55-3f2b8e6d7c10"));
});

test("an item that is not there, and an address that is not a record's, are refused with a plain reason", async t => {
  const { v } = await mk(t);
  assert.throws(() => v.links.link({ item: "nope", to: CLIENT }, "cli"), { code: "not_found", message: /no item named nope/ });
  for (const to of ["", "client/1", "https://example.test/x", "vyre://spc_a/client", "vyre://spc_a/client/../../etc"]) assert.throws(() => v.links.link({ item: "portal-login", to }, "cli"), { code: "bad_input" }, to);
  assert.equal(LINKED_URN.test(CLIENT), true);
});

test("the uses of the linked items are lines about who and when, newest first, from the audit log alone", async t => {
  const { v, password } = await mk(t);
  v.links.link({ item: "portal-login", to: CLIENT }, "cli");
  v.audit("agent-fill", "portal-login", "mcp agent:kit", true, "agent:kit", { origin: "https://portal.example.test" });
  await new Promise(r => setTimeout(r, 5));
  v.audit("copy", "portal-login", "cli", true, null);
  v.audit("fill", "portal-login", "cli", false, "refused"); // a refused try is not a use
  v.audit("fill", "other-login", "cli", true, null);       // another item is not this record's
  const { uses } = v.links.usesFor({ urn: CLIENT });
  assert.deepEqual(uses.map(u => u.line), ["portal-login was copied by you", "portal-login was used to sign in by the agent kit"]);
  assert.ok(uses[0].at >= uses[1].at);
  assert.deepEqual(v.links.usesFor({ urn: MATTER }).uses, [], "a record with no link has none");
  assert.ok(!JSON.stringify(uses).includes(password));
});

test("deleting the item takes its links with it; who used it is said in words, never as an id", async t => {
  const { v } = await mk(t);
  v.links.link({ item: "portal-login", to: CLIENT }, "cli");
  v.remove({ name: "portal-login" }, "cli");
  assert.deepEqual(v.links.list().links, []);
  assert.equal(byWords("mcp agent:kit"), "the agent kit");
  assert.equal(byWords("module:appmods"), "Vyre's appmods module");
  assert.equal(byWords("device:abcdefghijklmnop:laptop chrome"), "one of your devices");
  assert.equal(byWords("cli"), "you");
});
