// @ts-check
// prove.js: the interim presence gate. Every proof here is a test hook or the fake enclave
// helper; no test shows a dialog.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { proof, gate, PROVE_TOOLS, COOLDOWN_MS } from "./prove.js";
import { Helper } from "./mac/helper.js";
import { writeFakes } from "./mac/fakes.js";
import { recorded } from "./testing.js";
import { SCRATCH } from "../../test/scratch.mjs";

const tmpdir = t => { const d = fs.mkdtempSync(path.join(SCRATCH, "vyre-prove-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const env = (over = {}) => ({ enclave: null, platform: "darwin", config: {}, peer: null, test: null, state: { chain: Promise.resolve(), cooldownUntil: 0 }, now: Date.now, ...over });
const presence = e => /** @type {any} */ (e).code === "presence_required";

test("prove: the Deck needs confirm, and the owner when the daemon names the peer", async () => {
  const p = (input, e) => proof.prove({ tool: "vault.reveal", input, caller: "deck", summary: `Show the password of login "mail"`, env: env(e) });
  await assert.rejects(p({ name: "mail" }), e => presence(e) && /confirm on the Deck: Show the password/.test(e.message));
  await p({ name: "mail", confirm: true });
  await assert.rejects(p({ confirm: true }, { peer: { login: "dana@acme.test" }, config: { vault: { owner: "alex@example.com" } } }), /only the owner/);
  await p({ confirm: true }, { peer: { login: "Alex@example.com" }, config: { vault: { owner: "alex@example.com" } } });
  await assert.rejects(p({ confirm: true }, { peer: { login: "alex@example.com" } }), /only the owner/, "no owner configured: nobody on the tailnet counts");
});

test("prove: a machine without Touch ID refuses in words; mcp can never prove", async () => {
  await assert.rejects(proof.prove({ tool: "vault.inject", input: {}, caller: "cli", summary: "x", env: env({ platform: "linux" }) }), /no Touch ID/);
  await assert.rejects(proof.prove({ tool: "vault.inject", input: {}, caller: "cli", summary: "x", env: env({ enclave: null }) }), /no Touch ID/);
  await assert.rejects(proof.prove({ tool: "vault.reveal", input: {}, caller: "mcp", summary: "x", env: env() }), /mcp callers cannot prove/);
});

test("prove: Touch ID through the enclave helper's auth verb, with a cooldown after a cancel", async t => {
  const dir = tmpdir(t);
  const ok = writeFakes(path.join(dir, "ok")), no = writeFakes(path.join(dir, "no"), { enclaveMode: "refuse" });
  const e = env({ enclave: new Helper({ name: "enclave", dir, command: ok.helpers.enclave }) });
  await proof.prove({ tool: "vault.copy", input: {}, caller: "cli", summary: `Copy the password of login "mail"`, env: e });
  assert.deepEqual(JSON.parse(fs.readFileSync(ok.state.enclave, "utf8").trim()), { auth: `Copy the password of login "mail"` });
  let clock = 1000;
  const e2 = env({ enclave: new Helper({ name: "enclave", dir, command: no.helpers.enclave }), now: () => clock });
  await assert.rejects(proof.prove({ tool: "vault.copy", input: {}, caller: "capsule", summary: "s", env: e2 }), /not confirmed/);
  e2.enclave = new Helper({ name: "enclave", dir, command: ok.helpers.enclave });
  await assert.rejects(proof.prove({ tool: "vault.copy", input: {}, caller: "capsule", summary: "s", env: e2 }), /wait 30 seconds/);
  clock += COOLDOWN_MS + 1;
  await proof.prove({ tool: "vault.copy", input: {}, caller: "capsule", summary: "s", env: e2 });
});

test("gate: skips for modules, an open session, a registry that checked, and git store; otherwise asks", async t => {
  const asked = [];
  const real = proof.prove;
  proof.prove = async req => { asked.push(req.tool); };
  t.after(() => { proof.prove = real; });
  const audits = [];
  const vault = { sessions: { ok: (s, n) => s === "tok" && n === "mail" }, audit: (...a) => audits.push(a), enclave: null };
  const g = gate({ ctx: { config: {} }, vault });
  const def = n => g(n, { input: { type: "object", properties: {} }, run: async () => "ran", presence: { summary: async () => "words" } });
  assert.equal(await def("vault.reveal").run({ name: "mail" }, { caller: "module:mail" }), "ran");
  assert.equal(await def("vault.reveal").run({ name: "mail", session: "tok" }, { caller: "deck" }), "ran");
  assert.equal(await def("vault.reveal").run({ name: "other", session: "tok" }, { caller: "deck" }), "ran");
  assert.equal(await def("vault.git").run({ action: "store" }, { caller: "cli" }), "ran");
  assert.equal(await def("vault.git").run({ action: "get" }, { caller: "cli" }), "ran");
  assert.equal(await def("vault.inject").run({}, { caller: "cli", presence: { ok: true } }), "ran");
  assert.deepEqual(asked, ["vault.reveal", "vault.git"]);
  assert.ok(def("vault.reveal").input.properties.confirm, "confirm is in the schema");
  const enforced = gate({ ctx: { config: {}, presenceEnforced: true }, vault });
  await enforced("vault.backup", { run: async () => "ran" }).run({}, { caller: "cli" });
  assert.equal(asked.length, 2);
  const plain = { run: async () => "x" };
  assert.equal(g("vault.list", plain), plain, "names-only tools are not wrapped");
  for (const n of ["vault.reveal", "vault.copy", "vault.inject", "vault.backup", "vault.session.open", "vault.device.unlock"]) assert.ok(PROVE_TOOLS.has(n));
  proof.prove = async () => { throw Object.assign(new Error("presence was not confirmed"), { code: "presence_required" }); };
  await assert.rejects(def("vault.copy").run({ name: "mail" }, { caller: "cli" }), /not confirmed/);
  assert.equal(audits.at(-1)[0], "presence");
});

test("gate in the module: the test hook denies value tools and records summaries, names-only tools still work", async t => {
  const dir = tmpdir(t);
  const record = path.join(dir, "proofs.jsonl");
  const { run } = await recorded(t, { testHelpers: { prove: { mode: "deny", record } } });
  const value = `fixture-${Date.now()}-value`;
  await run("vault.put", { name: "billing-key", kind: "api-key", value });
  await assert.rejects(run("vault.inject", { items: [{ name: "billing-key", env: "BILLING_KEY" }] }), e => presence(e));
  await assert.rejects(run("vault.totp", { name: "billing-key" }), e => presence(e));
  assert.equal((await run("vault.list", {})).items.length, 1);
  const lines = fs.readFileSync(record, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.tool), ["vault.inject", "vault.totp"]);
  assert.match(lines[0].summary, /"billing-key" as BILLING_KEY/);
  assert.ok(!fs.readFileSync(record, "utf8").includes(value));
});
