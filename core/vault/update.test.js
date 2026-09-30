// @ts-check
// The Deck's vault tools inside a real vyred: vault.update (merge, generate on the box),
// vault.health, vault.caps and the breach check's off switch, and that none of them lets a
// canary value out through a result, an error, an event, a log line, the audit trail or a listing.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, writeModule, present } from "../../test/helpers.js";
import { Helper } from "./mac/helper.js";
import { writeFakes } from "./mac/fakes.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const sha = v => crypto.createHash("sha256").update(v).digest("hex");

const PROBE = `export default { async start(ctx) {
  ctx.tool("probe.use", { input: { type: "object", properties: { name: { type: "string" }, field: { type: "string" } } },
    run: async ({ name, field }) => { const v = await ctx.vault.fetch(name, field ? { field } : {});
      const c = await import("node:crypto"); return { sha: c.createHash("sha256").update(v).digest("hex"), len: v.length }; } });
  return { async stop() {} };
} };`;

async function boot(t, vault = { keystore: "file" }) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault }));
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.use"] }, needs: { vault: ["per-item"] } }, PROBE);
  const lines = [];
  const d = await start({ presence: present, root, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  return { root, d, lines, as: caller => (tool, input = {}) => call(tool, input, { root, caller }) };
}

test("vault.update: merges fields, generates on the box, never returns a value", async t => {
  const { d, as, lines, root } = await boot(t);
  const deck = as("deck"), cli = as("cli");
  const canary = fake("canary");
  const user = "alex@acme.test";

  const made = await deck("vault.update", { name: "acme-mail", kind: "login", url: "https://mail.acme.test/login", fields: { username: user }, generate: { field: "password", length: 32, symbols: false } });
  assert.equal(made.error, undefined, made.error?.message);
  assert.deepEqual(made.data, { name: "acme-mail", kind: "login", created: true, changed: ["password", "username"], generated: "password", bits: made.data.bits });
  assert.ok(made.data.bits > 150);
  await cli("vault.grant", { name: "acme-mail", module: "probe" });
  const first = (await cli("probe.use", { name: "acme-mail" })).data;
  assert.equal(first.len, 32, "the generated password is stored");

  // Change only the username: the password stays exactly as it was.
  const r = await deck("vault.update", { name: "acme-mail", fields: { username: "dana@acme.test" } });
  assert.deepEqual(r.data.changed, ["username"]);
  assert.equal((await cli("probe.use", { name: "acme-mail" })).data.sha, first.sha);
  assert.equal((await cli("probe.use", { name: "acme-mail", field: "username" })).data.sha, sha("dana@acme.test"));
  assert.deepEqual((await cli("vault.list")).data.items[0].hosts, ["https://mail.acme.test"], "hosts and url are kept");

  // Replace with a typed value (the canary), then add and remove a TOTP seed.
  await deck("vault.update", { name: "acme-mail", fields: { password: canary, totp: "JBSWY3DPEHPK3PXP" } });
  assert.equal((await cli("probe.use", { name: "acme-mail" })).data.sha, sha(canary));
  await deck("vault.update", { name: "acme-mail", remove: ["totp"] });
  assert.deepEqual((await cli("vault.list")).data.items[0].fields.sort(), ["password", "username"]);

  // Passphrase generation, and a new secret whose only value is generated.
  const w = await deck("vault.update", { name: "acme-key", kind: "secret", generate: { words: 5 } });
  assert.equal(w.data.generated, "value");

  // Refusals: changing the kind, a bad field name, and Claude.
  assert.match((await deck("vault.update", { name: "acme-mail", kind: "note" })).error.message, /make a new item/);
  assert.match((await deck("vault.update", { name: "acme-mail", fields: { "bad name": "x" } })).error.message, /not allowed/);
  assert.equal((await as("mcp")("vault.update", { name: "x", kind: "secret", fields: { value: "y" } })).error.code, "denied");
  assert.equal((await as("mcp")("vault.breach.check")).error.code, "denied");

  // No canary anywhere a value must never be.
  const events = JSON.stringify(d.events.since(0, { limit: 1000 }));
  const audit = JSON.stringify((await cli("vault.audit", { limit: 500 })).data);
  const listing = JSON.stringify(d.registry.listTools("mcp")) + JSON.stringify((await cli("vault.list")).data);
  const health = JSON.stringify((await as("mcp")("vault.health")).data);
  for (const [where, text] of Object.entries({ events, audit, listing, health, logs: lines.join("\n") })) assert.ok(!text.includes(canary), `canary in ${where}`);
  const db = fs.readFileSync(path.join(root, "vyre.db")).toString("latin1");
  assert.ok(!db.includes(canary), "canary in vyre.db");
});

test("vault.health, vault.caps and the breach switch through vyred", async t => {
  const { as } = await boot(t);
  const cli = as("cli"), mcp = as("mcp"), deck = as("deck");
  const shared = fake("shared");
  await cli("vault.put", { name: "forum", kind: "login", fields: { username: "alex", password: "Summer2024!" }, url: "https://forum.acme.test" });
  await cli("vault.put", { name: "gh", kind: "login", fields: { username: "alex", password: shared }, url: "https://github.com/login" });
  await cli("vault.put", { name: "deploy", kind: "secret", fields: { value: shared } });
  const h = (await mcp("vault.health")).data;
  const by = Object.fromEntries(h.items.map(i => [i.name, i.reasons]));
  assert.deepEqual(by.forum, ["weak"]);
  assert.deepEqual(by.gh, ["reused", "2fa-available", "passkey-available"]);
  assert.deepEqual(by.deploy, ["reused"]);
  assert.ok(!JSON.stringify(h).includes(shared));
  assert.ok(mcpTools(await mcp("vault.caps")));

  assert.deepEqual((await deck("vault.caps")).data, { reveal: true, breach: "off", host: "test-box" }, "reveal is on, behind presence (SPEC 11 rule 8)");
  assert.match((await deck("vault.breach.check")).error.message, /off/, "off by default: no network call is made");
});

test("vault.caps follows config", async t => {
  const { as } = await boot(t, { keystore: "file", breach: "ask" });
  assert.deepEqual((await as("deck")("vault.caps")).data, { reveal: true, breach: "ask", host: "test-box" });
});

test("vault.health nudges Touch ID only when a Mac has the enclave and a personal vault to unlock", async t => {
  const { d, as, root } = await boot(t);
  const cli = as("cli"), deck = as("deck");

  // No personal vault yet: nothing to unlock with Touch ID, so no nudge even with an enclave.
  const vaultMod = d.registry.modules.get("vault").handle.vault;
  const f = writeFakes(path.join(root, "fakes"), { enclaveMode: "ok" });
  const enclave = () => new Helper({ name: "enclave", dir: path.join(root, "helpers"), command: f.helpers.enclave });
  vaultMod.enclave = enclave();
  assert.deepEqual((await deck("vault.health")).data.touchid, { enrolled: false, available: false });

  // A personal vault exists, no enclave: available is false regardless.
  const pw = fake("acct");
  await cli("vault.account.create", { password: pw });
  vaultMod.enclave = null;
  assert.deepEqual((await deck("vault.health")).data.touchid, { enrolled: false, available: false });

  // Both: available, not yet enrolled.
  vaultMod.enclave = enclave();
  assert.deepEqual((await deck("vault.health")).data.touchid, { enrolled: false, available: true });

  // Enrolled: the nudge clears.
  await cli("vault.account.enroll-touchid", { password: pw });
  assert.deepEqual((await deck("vault.health")).data.touchid, { enrolled: true, available: true });
});

const mcpTools = r => !r.error;
