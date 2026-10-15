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
  for (const m of [{ name: "mail", needs: { kernel: { reach: true } } }, { name: "flows", needs: { kernel: { reach: true } } }, { name: "sessions", needs: { kernel: {} } }]) {
    const other = d.kernel.kernelFor(m);
    assert.equal(other.vault, undefined, `${m.name} has no vault handle`);
    assert.equal(other.personMay, undefined, `${m.name} cannot ask`);
  }
});

test("personMay is on the vault, mail and comms handles only, and each asks only about its own actions", { timeout: 120_000 }, async t => {
  const d = await boot(tempHome(t), { kernelPresence: { check: async () => null } });
  const owner = d.kernel.id.owner, space = d.kernel.id.space;
  for (const name of ["mail", "comms"]) {
    const h = d.kernel.kernelFor({ name, needs: {} });
    assert.equal(typeof h.personMay, "function", `${name} has it`);
    assert.equal(await h.personMay(owner, "drive.read", `vyre://${space}/file/Rota/week1.pdf`), true, "the owner may read a file");
    assert.equal(await h.personMay("per_nobody1234567890abcdefgh", "drive.read", `vyre://${space}/file/Rota/week1.pdf`), false);
    await assert.rejects(() => h.personMay(owner, "vault.call", `vyre://${space}/vault/x/connection/y`), { code: "bad_input" }, `${name} asks only about files`);
  }
  for (const name of ["sessions", "flows", "agents", "files", "work"]) assert.equal(d.kernel.kernelFor({ name, needs: {} }).personMay, undefined, `${name} does not have it`);
  const vault = d.kernel.kernelFor(VAULT);
  await assert.rejects(() => vault.vault.personMay(owner, "drive.read", `vyre://${space}/file/x`), { code: "bad_input" }, "the vault asks only about credentials");
});
