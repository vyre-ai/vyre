// @ts-check
// A first-party module making grants for someone else (one-grant model, step a): only for the actions and address prefixes its manifest lists in `needs.kernel.mints`, from a source of its own name; the kernel
// refuses anything else, and a module with no list has no way to mint at all.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";

const S = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };

async function rig() {
  const k = await createKernel({ space: S, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const pub = k.kernelFor({ name: "publish", needs: { kernel: { actions: [], mints: [{ prefix: "credential/*", actions: ["vault.fill", "vault.release"] }] } } });
  const other = k.kernelFor({ name: "wink", needs: { kernel: { actions: [] } } });
  const dep = { kind: "service", id: "deployment-1", space: S };
  const input = (/** @type {any} */ over = {}) => ({ subject: { kind: "actor", actor: dep }, actions: ["vault.release"], resource: { prefix: `vyre://${S}/credential/stripe` }, source: "publish:deployment-1", reason: "a secret for one deployment", ...over });
  const live = async () => (await k.gateway.grants.list(owner)).filter((/** @type {any} */ g) => g.source.startsWith("publish:") && g.status === "active");
  return { k, owner, pub, other, input, live };
}

test("a module mints a grant inside its manifest's list, and the grant is in the log under its name", async () => {
  const { pub, input, live, k } = await rig();
  const id = await pub.mint.make(input());
  const [g] = await live();
  assert.equal(g.id, id); assert.deepEqual(g.issuer, { kind: "service", id: "publish", space: S });
  assert.ok(k.log.read({ type: "grant.created" }).some((/** @type {any} */ e) => e.data.grant.id === id));
});

test("the kernel refuses a mint outside the list: another action, another address, another module's source, a subject that is not an actor or group", async () => {
  const { pub, input, live } = await rig();
  for (const [what, over] of /** @type {[string, any][]} */ ([
    ["an action it did not list", { actions: ["vault.read"] }],
    ["one listed and one not", { actions: ["vault.fill", "records.read"] }],
    ["an address outside its prefix", { resource: { prefix: `vyre://${S}/contact/c1` } }],
    ["a wider address than its prefix", { resource: { prefix: `vyre://${S}/*/*` } }],
    ["another module's source", { source: "wink:W1" }],
    ["a role subject", { subject: { kind: "role", name: "admin" } }],
  ])) await assert.rejects(() => pub.mint.make(input(over)), { code: /not_allowed|bad_input/ }, what);
  assert.equal((await live()).length, 0, "nothing was made");
});

test("a module whose manifest lists no mints has no way to mint, and cannot end another module's grants", async () => {
  const { pub, other, input, live } = await rig();
  assert.equal(other.mint, undefined);
  await pub.mint.make(input());
  const ended = await pub.mint.end({ source: "wink:W1" });
  assert.deepEqual(ended, [], "a source that is not its own ends nothing");
  assert.equal((await live()).length, 1);
  assert.equal((await pub.mint.end({ source: "publish:deployment-1", reason: "retired" })).length, 1);
  assert.equal((await live()).length, 0);
});

test("a made grant survives a rebuild from the log", async () => {
  const { k, pub, input, live } = await rig();
  await pub.mint.make(input());
  await k.gateway.grants.rebuild();
  assert.equal((await live()).length, 1);
});
