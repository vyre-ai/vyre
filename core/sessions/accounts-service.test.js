// @ts-check
// A team member's own AI sign-in through the Space's remote server (0.3.3 G03), on a REAL vyred with the kernel on and a REAL hosted team Space: a member signs a Codex login in as an account of their own
// (the provider's login command runs as that account), sees only their own accounts, and no one else's turn can use it: not the owner's, not another member's. A key is not offered (it needs a Vault of
// their own, 0.3.4). Stand-ins, labelled: SHIM(presence) `kernelPresence` accepts any proof for the owner's grants acts; SHIM(login) the provider's login command is a script that prints a device code and
// writes a token file in the account's HOME. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CALLS } from "../../kernel/remote/wire.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const OWNER = "per_" + "abcdefghijklmnopqrstuvwxyz", ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ZED = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-login.js");

/** A daemon with a `codex` login on its PATH, a hosted team Space with the owner and two members, and the member door's accounts service for it. @param {any} t */
async function world(t) {
  const root = tempHome(t);
  const bin = path.join(root, "shim");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(FAKE, path.join(bin, "codex"));
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const facts = (/** @type {string} */ person) => ({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  const owner = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await firm.gateway.grants.setRole(owner, { person, role: "member" }, { presence: proof() });
  const handle = /** @type {any} */ (d.registry.modules.get("sessions")).handle;
  assert.equal(typeof handle.peerService, "function", "the sessions module offers its member sign-in service to the peer door");
  const svc = handle.peerService({ space: firm.space, kernel: firm.kernel, registry: d.registry });
  const chainOf = (/** @type {string} */ person, space = firm.space) => (space === firm.space ? firm.kernel : d.kernel).chains.fromFacts(facts(person));
  return { d, root, firm, svc, chainOf, as: (/** @type {string} */ person, /** @type {string} */ call, input = {}) => svc[call](chainOf(person), input) };
}

/** Sign the person in on codex through the service and wait for the provider's login to finish. @param {any} w */
async function signIn(w, person, label) {
  const first = await w.as(person, "signin", { provider: "codex", label });
  assert.equal(first.step, "code", JSON.stringify(first));
  for (let i = 0; i < 100; i++) { const s = await w.as(person, "signin", { flow: first.flow }); if (s.step === "done") return first; await new Promise(r => setTimeout(r, 100)); }
  throw new Error("the sign-in did not finish");
}

test("the accounts a member reaches are five calls: sign-in, and a key kept in their own vault", () => {
  assert.deepEqual(CALLS.accounts, ["list", "signin", "remove", "default", "add"]);
});

test("a member signs in on their own account; it is theirs alone: not the owner's, not another member's, and no one else's turn resolves to it", { timeout: 90_000 }, async t => {
  const w = await world(t);
  assert.deepEqual((await w.as(ANA, "list", { provider: "codex" })).filter((/** @type {any} */ a) => !a.synthetic), [], "Ana starts with no account");
  await signIn(w, ANA, "Ana's Codex");
  const mine = await w.as(ANA, "list", { provider: "codex" });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].label, "Ana's Codex");
  assert.equal(mine[0].person, ANA, "the account is Ana's");
  assert.equal(mine[0].vault_item, null, "no vault item: a login keeps its token in the account's own HOME");
  assert.deepEqual(await w.as(BEN, "list", { provider: "codex" }), [], "Ben sees none of Ana's");
  const home = await w.d.registry.call("sessions.accounts.list", { provider: "codex" }, "cli", {});
  assert.deepEqual((home.data || []).filter((/** @type {any} */ a) => a.label === "Ana's Codex"), [], "the owner's own list does not show Ana's account");
  const res = async (/** @type {string} */ person) => (await w.d.registry.call("sessions.accounts.resolve", { provider: "codex", person }, "module:vyred", {})).data;
  assert.equal((await res(ANA)).id, mine[0].id, "Ana's turn runs on Ana's account");
  assert.equal(await res(BEN), null, "Ben's turn does not fall back to Ana's, and he has none of his own");
  assert.equal(await res(OWNER), null, "the owner's turn does not use Ana's account either");
  assert.ok(fs.existsSync(path.join(w.root, "accounts", mine[0].id, ".fake", "auth.json")), "the login wrote its token in Ana's own account folder");
});

test("a member cannot touch another member's account, and a key can only be one of their own vault", { timeout: 90_000 }, async t => {
  const w = await world(t);
  await signIn(w, ANA, "Ana's Codex");
  const [ana] = await w.as(ANA, "list", {});
  await assert.rejects(() => w.as(BEN, "remove", { id: ana.id }), /no account/, "Ben removing Ana's account: not found, never not yours");
  await assert.rejects(() => w.as(BEN, "default", { id: ana.id }), /no account/);
  await assert.rejects(() => w.as(BEN, "signin", { provider: "codex", account: ana.id }), /no account/, "Ben signing Ana's account in again");
  assert.equal(w.svc.key, undefined, "no shortcut that stores a key in the owner's vault");
  for (const item of ["nonesuch", "claude-setup-token", "anthropic-api-key"]) await assert.rejects(() => w.as(ANA, "add", { provider: "claude", kind: "api-key", label: "Mine", vault_item: item }), /own vault/, `${item}: a key is named in her own vault, never the owner's`);
  assert.deepEqual((await w.as(ANA, "list", { provider: "claude" })).filter((/** @type {any} */ a) => !a.synthetic), [], "nothing was added");
  assert.equal((await w.as(ANA, "list", {})).length, 1, "Ana's account is still there");
});

test("a member has one sign-in account on the server: a second is refused with the next step, and removing the first frees the place", { timeout: 90_000 }, async t => {
  const w = await world(t);
  await signIn(w, ANA, "First");
  const [first] = await w.as(ANA, "list", { provider: "codex" });
  await w.as(ANA, "default", { id: first.id });
  assert.equal(((await w.d.registry.call("sessions.accounts.resolve", { provider: "codex", person: ANA }, "module:vyred", {})).data).id, first.id);
  await assert.rejects(() => w.as(ANA, "signin", { provider: "codex", label: "Second" }), /remove it first/, "the refusal says what to do");
  await w.as(ANA, "remove", { id: first.id });
  assert.deepEqual(await w.as(ANA, "list", { provider: "codex" }), []);
  await signIn(w, ANA, "Second");
  assert.deepEqual((await w.as(ANA, "list", { provider: "codex" })).map((/** @type {any} */ a) => a.label), ["Second"]);
});

test("nobody else reaches the service: a non-member, an agent's chain, another Space's chain; and the serve tool answers only the daemon's own door", { timeout: 90_000 }, async t => {
  const w = await world(t);
  await assert.rejects(() => w.as(ZED, "list", {}), /not found/, "a person who is not a member");
  await assert.rejects(() => w.svc.signin(w.chainOf(ANA, "spc_zzzzzzzzzzzz"), { provider: "codex" }), /not found/, "another Space's chain");
  for (const caller of ["cli", "mcp", "device:abcdefghijklmnop", "module:sneaky", "space:per_zed@spc_abcdefghijkl", "capsule"]) {
    const r = await w.d.registry.call("sessions.accounts.serve", { call: "list", person: ANA, space: w.firm.space, input: {} }, caller, {});
    assert.ok(r.error, `${caller} is refused: ${JSON.stringify(r).slice(0, 160)}`);
  }
});

test("the door never passes a missing person: serve refuses an empty, missing or odd person, and a chain with no person hop gets nothing", { timeout: 90_000 }, async t => {
  const w = await world(t);
  for (const person of [undefined, "", null, "per bad", 7]) {
    const r = await w.d.registry.call("sessions.accounts.serve", { call: "list", person, space: w.firm.space, input: {} }, "module:vyred", { door: true });
    assert.ok(r.error, `a person of ${JSON.stringify(person)} is refused: ${JSON.stringify(r).slice(0, 160)}`);
  }
  const noPerson = { space: w.firm.space, hops: [{ actor: { kind: "agent", id: "kit", space: w.firm.space } }] };
  await assert.rejects(() => w.svc.list(noPerson, {}), /not found/);
  await assert.rejects(() => w.svc.list({ space: w.firm.space, hops: [] }, {}), /not found/);
});
