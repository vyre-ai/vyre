// @ts-check
// Per-person AI accounts: a member's sign-in is theirs. They add, list, bind and remove their own; the owner's accounts stay the owner's; and neither person can see, bind or remove the other's, by
// list or by naming its id. On a real daemon. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("a member's AI account is theirs: listed, bound and removed by them only; the owner's likewise", { timeout: 180_000 }, async t => {
  const d = await start({ root: tempHome(t), presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner, BOB = "per_" + "b".repeat(26);
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
  const as = async (/** @type {string} */ person, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(chainOf(person), {})).token });
  const mine = async (/** @type {string} */ person) => ((await as(person, "sessions.accounts.list", { provider: "codex" })).data || []).map((/** @type {any} */ a) => a.label).sort();

  const o = await as(owner, "sessions.accounts.add", { provider: "codex", label: "Owner login", kind: "login" });
  assert.ok(!o.error, JSON.stringify(o.error));
  const b = await as(BOB, "sessions.accounts.add", { provider: "codex", label: "Bob login", kind: "login" });
  assert.ok(!b.error, JSON.stringify(b.error));
  const key = await as(BOB, "sessions.accounts.add", { provider: "codex", label: "Bob names the owner's item", vault_item: "owner-secret", kind: "api-key" });
  assert.equal(key.error?.code, "denied", "a member cannot name a vault item (it would be the owner's): a key account is refused");
  assert.deepEqual(await mine(owner), ["Owner login"], "the owner lists the home's own");
  assert.deepEqual(await mine(BOB), ["Bob login"], "Bob lists his own and not the owner's");

  assert.equal((await as(BOB, "sessions.accounts.remove", { id: o.data.id })).error?.code, "not_found", "Bob cannot remove the owner's account by its id");
  assert.equal((await as(owner, "sessions.accounts.remove", { id: b.data.id })).error?.code, "not_found", "nor the owner Bob's");
  assert.equal((await as(BOB, "sessions.accounts.bind", { id: o.data.id, project: "x" })).error?.code, "not_found");
  assert.equal((await as(BOB, "sessions.accounts.add", { provider: "grok", label: "Bob second", kind: "login" })).error?.code, "too_many", "a member has one sign-in account on the server");

  // the home resolves an account for a turn by its person: Bob's turn gets Bob's, the owner's gets the home's own, a person with none gets none
  const resolve = async (/** @type {any} */ q) => (await d.registry.call("sessions.accounts.resolve", { provider: "codex", ...q }, "module:vyred")).data;
  assert.equal((await resolve({ person: BOB })).id, b.data.id);
  assert.equal((await resolve({ person: owner })).id, o.data.id);
  assert.equal(await resolve({ person: "per_" + "e".repeat(26) }), null, "a person with no account of their own gets none, not the owner's");
  assert.ok(!(await as(BOB, "sessions.accounts.remove", { id: b.data.id })).error, "Bob removes his own");
  assert.deepEqual(await mine(BOB), []);
  assert.deepEqual(await mine(owner), ["Owner login"]);
});
