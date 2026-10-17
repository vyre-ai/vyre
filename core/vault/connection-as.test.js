// @ts-check
// `as` on the hub's token and revoke asks: the MCP hub names the member the call is for (its tool took her from the verified chain, one person and no agent). With it, her own connection answers with her token and a share answers
// with the kernel's word about her; Bob gets nothing for Alice's, nor does the Space owner, nor a made-up id. Revoking is the connection's owner's own act. With no `as`, an agent hop or a bare service chain gets nothing, as before.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionTokens, connectionUrn, revokeAllowed } from "./connection-token.js";

const ALICE = "per_alice0000000000000000000", BOB = "per_bob00000000000000000000000", CY = "per_cy000000000000000000000000", OWNER = "per_owner00000000000000000000";
const SPACE = "spc_test";

/** @param {{ hops?: any[], shared?: Record<string, string[]> }} [o] */
function rig(o = {}) {
  /** @type {any[]} */ const asked = [];
  const kernel = {
    owner: OWNER, space: SPACE,
    chain: async () => ({ hops: o.hops || [{ actor: { kind: "service", id: "vault", space: SPACE } }] }),
    authorize: async () => ({ effect: "deny", reason: "no_grant" }),
    vault: { personMay: async (/** @type {string} */ person, /** @type {string} */ action, /** @type {string} */ resource) => { asked.push({ person, action, resource }); return (o.shared?.[person] || []).includes(action) && resource === connectionUrn(SPACE, ALICE, "notion-alice-auth"); } },
  };
  const people = { service: (/** @type {string} */ owner) => ({ get: async () => ({ fields: { auth_kind: "bearer", token: `SECRET-${owner}` } }) }) };
  return { asked, tokens: new ConnectionTokens({ people: /** @type {any} */ (people), kernel }) };
}
const ask = (/** @type {ConnectionTokens} */ t, /** @type {any} */ more = {}) => t.token({ owner: ALICE, connection: "notion-alice-auth", ...more }, {});
const refused = async (/** @type {Promise<any>} */ p, /** @type {string} */ what) => { const r = await p.then(() => null, e => e); assert.ok(r && r.code === "denied", what); assert.ok(!/SECRET/.test(String(r.message)), `${what}: the refusal carries no token`); };

test("as = Alice gets Alice's token; Bob, the Space owner and a made-up id get nothing for her connection; the Vault is asked about the named person only", async () => {
  const { tokens, asked } = rig();
  assert.equal((await ask(tokens, { as: ALICE })).access_token, `SECRET-${ALICE}`, "Alice reads through her own connection");
  assert.equal((await ask(tokens, { as: ALICE, write: true })).access_token, `SECRET-${ALICE}`, "and writes: it is hers");
  await refused(ask(tokens, { as: BOB }), "Bob");
  await refused(ask(tokens, { as: BOB, write: true }), "Bob writing");
  await refused(ask(tokens, { as: OWNER }), "the Space owner");
  await refused(ask(tokens, { as: "alice" }), "a made-up id");
  await refused(ask(tokens, { as: "" }), "an empty id");
  assert.deepEqual([...new Set(asked.map(a => a.person))], [BOB], "the kernel was asked about Bob and no one else");
});

test("a share answers by the kernel's word about the grantee at the level the call needs", async () => {
  const { tokens } = rig({ shared: { [CY]: ["vault.read"] } });
  assert.equal((await ask(tokens, { as: CY })).access_token, `SECRET-${ALICE}`, "Cy reads through what Alice shared");
  await refused(ask(tokens, { as: CY, write: true }), "Cy writing with a read share");
});

test("with no `as`, a bare service chain or an agent hop gets no token (today's path), and `as` does not widen it", async () => {
  const bare = rig();
  await refused(ask(bare.tokens), "no person on the hop");
  const agent = rig({ hops: [{ actor: { kind: "person", id: ALICE } }, { actor: { kind: "agent", id: "agt_x" } }] });
  await refused(ask(agent.tokens), "an agent behind Alice");
  assert.equal(agent.asked.length, 0, "no `as`, no question about a person");
});

test("revoking is the connection owner's own act: as = Bob is refused, as = Alice or no as (the hub's own pre-checked removal) is allowed", () => {
  assert.equal(revokeAllowed(ALICE, BOB), false);
  assert.equal(revokeAllowed(ALICE, OWNER), false);
  assert.equal(revokeAllowed(ALICE, ""), false);
  assert.equal(revokeAllowed(ALICE, ALICE), true);
  assert.equal(revokeAllowed(ALICE, undefined), true);
});
