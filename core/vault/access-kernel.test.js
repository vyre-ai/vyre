// @ts-check
// The vault module on a real daemon with the kernel on (a test box, never a Mac): the handle the kernel gives the module named `vault` reaches the owner's personal vault, carries older agent logins
// over, takes back what was lent, and asks "may this agent use this login at this origin"; and a grant to `project:<id>` names a project record that exists (kernel/index.js `projectExists`).
import "../../scripts/mac-test-guard.mjs";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "../../test/helpers.js";
import { start } from "../daemon/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const started = /** @type {any[]} */ ([]);
afterEach(async () => { for (const d of started.splice(0)) await d.stop().catch(() => {}); });
const boot = async (/** @type {string} */ root, over = {}) => { const d = await start({ root, log: () => {}, kernel: true, ...over }); started.push(d); return d; };
const VAULT = { name: "vault", needs: { kernel: { reach: true } } };

test("the vault's kernel handle: the owner's personal vault, agent logins carried over and taken back, the agent asked one login at one origin", { timeout: 120_000 }, async t => {
  const d = await boot(tempHome(t));
  const h = d.kernel.kernelFor(VAULT);
  const space = d.kernel.id.space, owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-vault", person: d.kernel.id.owner, path: "direct", session: "s" });
  const vid = await h.vault.personalVault();
  assert.match(vid, /^vault_/);
  assert.equal(await h.vault.personalVault(), vid, "one personal vault");
  const res = `vyre://${space}/vault/${vid}/item/harlow-drive`;
  const made = await h.vault.carryOver([{ id: "ag_1", who: "agt_kit", item: "harlow-drive", origin: "https://app.harlow.test", expires: Date.now() + 86400_000 }]);
  assert.equal(made.length, 1);
  assert.equal(await h.agentMay("agt_kit", "vault.fill", res, "https://app.harlow.test"), true);
  assert.equal(await h.agentMay("agt_kit", "vault.fill", res, "https://evil.test"), false, "another origin");
  assert.equal(await h.agentMay("agt_juno", "vault.fill", res, "https://app.harlow.test"), false, "another agent");
  await assert.rejects(() => h.agentMay("agt_kit", "records.update", res), { code: "not_allowed" }, "only a read or the use of a credential is asked this way");
  assert.equal((await h.vault.takeBack({ prefix: res })).length, 1);
  assert.equal(await h.agentMay("agt_kit", "vault.fill", res, "https://app.harlow.test"), false, "taken back");
  assert.ok(owner);
});

test("a grant to project:<id> names a project record that exists", { timeout: 120_000 }, async t => {
  // presence is the vault tests' business: a verifier that accepts, so this asks only about the project
  const d = await boot(tempHome(t), { kernelPresence: { check: async () => null } });
  const h = d.kernel.kernelFor(VAULT);
  const space = d.kernel.id.space, owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-vault", person: d.kernel.id.owner, path: "direct", session: "s" });
  const proj = await d.kernel.gateway.records.create(owner, "project", { name: "Northwind", slug: "northwind" });
  const vid = await h.vault.personalVault();
  const give = (/** @type {string} */ id) => h.grants.create(owner, { subject: { kind: "group", id }, actions: ["vault.read"], resource: { prefix: `vyre://${space}/vault/${vid}` }, conditions: {}, source: "vault:share" }, { presence: { n: 1 } });
  await assert.rejects(() => give("project:nope"), { code: "bad_input" });
  assert.equal((await give(`project:${proj.id}`)).status, "active");
});

test("personMay: only the vault's handle answers whether a member may use a credential, and only allow or deny", { timeout: 120_000 }, async t => {
  const d = await boot(tempHome(t), { kernelPresence: { check: async () => null } });
  const h = d.kernel.kernelFor(VAULT), owner = d.kernel.id.owner, space = d.kernel.id.space;
  const vid = await h.vault.personalVault();
  const res = `vyre://${space}/vault/${vid}/connection/harlow-drive`;
  assert.equal(await h.vault.personMay(owner, "vault.call", res), true, "the owner holds it");
  assert.equal(await h.vault.personMay("per_nobody1234567890abcdefgh", "vault.call", res), false, "a stranger does not");
  await assert.rejects(() => h.vault.personMay(owner, "records.update", res), { code: "bad_input" }, "only the use of a credential is asked");
  // (mail, comms and google have a personMay of their own for drive.read since mail6/attachments: the next test is about them)
  for (const m of [{ name: "flows", needs: { kernel: { reach: true } } }, { name: "sessions", needs: { kernel: {} } }]) {
    const other = d.kernel.kernelFor(m);
    assert.equal(other.vault, undefined, `${m.name} has no vault handle`);
    assert.equal(other.personMay, undefined, `${m.name} cannot ask`);
  }
});

test("personMay is on the vault, mail and comms handles only, and each asks only about its own actions", { timeout: 120_000 }, async t => {
  const d = await boot(tempHome(t), { kernelPresence: { check: async () => null } });
  const owner = d.kernel.id.owner, space = d.kernel.id.space;
  for (const name of ["mail", "comms", "google"]) {
    const h = d.kernel.kernelFor({ name, needs: {} });
    assert.equal(typeof h.personMay, "function", `${name} has it`);
    assert.equal(await h.personMay(owner, "drive.read", `vyre://${space}/file/Rota/week1.pdf`), true, "the owner may read a file");
    assert.equal(await h.personMay("per_nobody1234567890abcdefgh", "drive.read", `vyre://${space}/file/Rota/week1.pdf`), false);
    await assert.rejects(() => h.personMay(owner, "vault.call", `vyre://${space}/vault/x/connection/y`), { code: "bad_input" }, `${name} asks only about files`);
  }
  for (const name of ["sessions", "flows", "agents", "files", "work", "documents"]) assert.equal(d.kernel.kernelFor({ name, needs: {} }).personMay, undefined, `${name} does not have it`);
  const vault = d.kernel.kernelFor(VAULT);
  await assert.rejects(() => vault.vault.personMay(owner, "drive.read", `vyre://${space}/file/x`), { code: "bad_input" }, "the vault asks only about credentials");
});

test("vault.connections.lend and .end answer only the flows module and the Space's own host, never another module, an agent or a person's surface", { timeout: 120_000 }, async t => {
  const d = await boot(tempHome(t), { kernelPresence: { check: async () => null } });
  const input = { task: "task-1", agent: "kit", connections: ["cn1"], until: Date.now() + 60_000, approver: d.kernel.id.owner };
  for (const tool of ["vault.connections.lend", "vault.connections.end"]) {
    for (const caller of ["module:mail", "module:sessions", "module:agents", "cli", "mcp", "mcp:agent:kit", "device:abcdefghijklmnop"]) {
      const r = await d.registry.call(tool, tool === "vault.connections.end" ? { task: "task-1" } : input, caller, {});
      assert.ok(r.error, `${tool} refuses ${caller}`);
      assert.ok(/only the flows module|not allowed|denied|no such|reach/i.test(String(r.error.message || r.error.code)), `${caller}: ${JSON.stringify(r.error).slice(0, 120)}`);
    }
  }
});

test("agentMay with a person: a member's agent holds the member's own grant on the member's own resource, and nothing else; a person who is not a member, or is the owner, gets no answer", { timeout: 120_000 }, async t => {
  const d = await boot(tempHome(t), { kernelPresence: { check: async () => null } });
  const K = d.kernel, h = K.kernelFor(VAULT), owner = K.id.owner, space = K.id.space;
  const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", EVE = "per_" + "defghijklmnopqrstuvwxyzabc", ORIGIN = "https://bank.example.test";
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-vault", person: owner, path: "direct", session: "s" });
  const ok = () => ({ presence: { n: Math.random() } });
  for (const p of [BEN, EVE]) await K.gateway.grants.setRole(ownerChain, { person: p, role: "member" }, ok());
  await K.gateway.grants.addActor(ownerChain, { kind: "agent", id: "agt_kit", space }, ok());
  const vid = await h.vault.personalVault();
  const benRes = `vyre://${space}/vault/${BEN}/item/mc-1`, eveRes = `vyre://${space}/vault/${EVE}/item/mc-2`, ownerRes = `vyre://${space}/vault/${vid}/item/o`;
  // the share's grant: the member's own, for this agent, on her own resource, at one origin
  await h.grants.create(ownerChain, { subject: { kind: "actor", actor: { kind: "agent", id: "agt_kit", space } }, actions: ["vault.fill"], resource: { prefix: benRes }, conditions: { where: { origins: [ORIGIN] } }, source: "vault:member-share:mc-1" }, ok());
  // and her own side: the share also gives HER Fill in on the copy's address, because a chain of [the member, the agent] holds only what both hold
  await h.grants.create(ownerChain, { subject: { kind: "actor", actor: { kind: "person", id: BEN, space } }, actions: ["vault.fill"], resource: { prefix: benRes }, conditions: { where: { origins: [ORIGIN] } }, source: "vault:member-share:mc-1:member" }, ok());
  assert.equal(await h.agentMay("agt_kit", "vault.fill", benRes, ORIGIN, false, undefined, BEN), true, "[the member, the agent] holds her grant on her resource");
  assert.equal(await h.agentMay("agt_kit", "vault.fill", benRes, ORIGIN), false, "with no person it is the owner's chain, which holds nothing in her folder");
  assert.equal(await h.agentMay("agt_kit", "vault.fill", benRes, "https://evil.test", false, undefined, BEN), false, "another origin");
  assert.equal(await h.agentMay("agt_kit", "vault.fill", eveRes, ORIGIN, false, undefined, BEN), false, "another member's resource");
  assert.equal(await h.agentMay("agt_kit", "vault.fill", eveRes, ORIGIN, false, undefined, EVE), false, "her own resource but no grant of the agent there");
  assert.equal(await h.agentMay("agt_kit", "vault.fill", ownerRes, ORIGIN, false, undefined, BEN), false, "the owner's resource");
  assert.equal(await h.agentMay("agt_kit", "vault.fill", benRes, ORIGIN, false, undefined, "per_nobody1234567890abcdefgh"), false, "a person who is not a member");
  assert.equal(await h.agentMay("agt_kit", "vault.fill", benRes, ORIGIN, false, undefined, owner), false, "the owner passed as the person");
  for (const bad of ["", "ben", "per_", "per_ben; drop", 7, null]) assert.equal(await h.agentMay("agt_kit", "vault.fill", benRes, ORIGIN, false, undefined, /** @type {any} */ (bad)), false, `a malformed person: ${String(bad)}`);
});
