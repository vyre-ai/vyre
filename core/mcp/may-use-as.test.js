// @ts-check
// Whose connection is it, as the hub asks the Vault: the member the tool named from the verified chain (who.me) is who the Vault is asked about. A row owned by Alice is read and removed by a call with exactly Alice;
// an agent behind the call, Bob, the Space owner, a call that carries a `me` in its own input, and a who that names no member are each refused, and the row is untouched. The Vault here answers as the real one does:
// the owner of the row, and anyone it is shared with.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub, whoFrom } from "./hub.js";

const ALICE = "per_alice0000000000000000000", BOB = "per_bob00000000000000000000000", OWNER = "per_owner00000000000000000000";

/** The Hub's mayUse over a Vault stand-in that holds only what is asked: it records every question. */
function rig() {
  /** @type {any[]} */ const asked = [];
  const hub = Object.create(Hub.prototype);
  hub.deps = { mayUseConnection: async (/** @type {any} */ c) => { asked.push(c); return c.level !== "own" && c.as === c.owner; } };
  const row = { name: "notion-alice", owner: ALICE, connection: "notion-alice-auth", label: "notion" };
  return { hub, row, asked };
}
/** What the mcp tool builds from the verified call: whoFrom(caller, meta) plus `me`, the member that call names. */
const whoFor = (/** @type {string} */ me, /** @type {any} */ meta = {}) => ({ ...whoFrom("device:abcdefghijklmnop", meta), me: async () => me });

test("a call with exactly Alice reads and removes her row; an agent behind it, Bob, the Space owner and a me in the input do not, and the row is untouched", async () => {
  const { hub, row, asked } = rig();
  // exactly Alice: read goes to the Vault as her and is answered; own is hers without asking
  assert.equal(await hub.mayUse(row, whoFor(ALICE), "read"), true, "Alice reads her row");
  assert.equal(asked.at(-1).as, ALICE, "the Vault was asked about Alice, from the tool's verified answer");
  assert.equal(await hub.mayUse(row, whoFor(ALICE), "own"), true, "Alice removes her row");
  // an agent hop on the call: the tool names no member (vault.me.who refuses an agent chain), so the Vault is asked as the caller, which has no person
  const agent = { ...whoFrom("mcp:agent:juno", { agent: "juno" }), me: async () => { throw new Error("an assistant is not a person: ask as yourself"); } };
  asked.length = 0;
  assert.equal(await hub.mayUse(row, agent, "read"), false, "an agent does not read Alice's row");
  assert.equal(await hub.mayUse(row, agent, "own"), false, "an agent does not remove it");
  assert.ok(asked.every(c => c.as === undefined), "the Vault was never told a person for an agent");
  // an agent that carries a me of Alice's anyway (a who the tool did not build) is refused by who.agent
  assert.equal(await hub.mayUse(row, { ...agent, me: async () => ALICE }, "own"), false, "who.agent wins over a me");
  // Bob, and the Space owner (who is no member): the Vault is asked about them and says no; own is not theirs
  for (const [who, me] of [["Bob", BOB], ["the Space owner", OWNER]]) {
    assert.equal(await hub.mayUse(row, whoFor(me), "read"), false, `${who} does not read Alice's row`);
    assert.equal(await hub.mayUse(row, whoFor(me), "own"), false, `${who} does not remove Alice's row`);
  }
  assert.equal(await hub.mayUse(row, whoFor(""), "own"), false, "a call that names no member does not remove it");
  // an input that says who it is: `me` and `who` are not read from anywhere but the tool's own build; whoFrom ignores both
  const forged = whoFrom("device:abcdefghijklmnop", /** @type {any} */ ({ me: ALICE, who: { me: ALICE } }));
  assert.equal(/** @type {any} */ (forged).me, undefined, "whoFrom builds no me from the call's meta");
  assert.equal(await hub.mayUse(row, forged, "own"), false, "a who with no verified me does not remove Alice's row");
  assert.equal(await hub.mayUse(row, { person: true, agent: null, thread: null, me: "per_not_a_function" }, "own"), false, "a me that is not the tool's function is not read");
  assert.equal(row.owner, ALICE, "the row is untouched");
});

test("a grantee's direct call of an outward tool is held (no token is asked for it); a read tool asks with write false; only a released item asks with write true, as its requester", async () => {
  const { hub, row, asks } = tokenRig();
  const who = { person: false, agent: null, thread: null, me: async () => CY2 };
  /** @type {string[]} */ const did = [];
  hub.row = () => row; hub.inScope = async () => true; hub.must = () => row;
  hub.findTool = (/** @type {any} */ _r, /** @type {string} */ tool) => ({ tool, outward: tool === "send_message", name: tool });
  hub.hold = async () => { did.push("held"); return { held: "g1" }; };
  hub.runInner = async () => hub.connectionHeaders(row);
  const out = await hub.call({ server: "notion-alice", tool: "send_message", arguments: {} }, who);
  assert.deepEqual([out.held, did, asks.length], ["g1", ["held"], 0], "an outward call is held and no token is asked for it");
  await hub.call({ server: "notion-alice", tool: "search", arguments: {} }, who);
  assert.deepEqual(asks.map(a => [a.as, a.write]), [[CY2, false]], "a read tool asks as the member, write false");
  asks.length = 0;
  hub.findTool = () => ({ tool: "send_message", outward: true });
  hub.retarget = (/** @type {any} */ a) => a;
  await hub.release({ id: "i1", to: [], content: { server: "notion-alice", tool: "send_message", arguments: {} } });
  assert.deepEqual(asks.map(a => [a.as, a.write]), [[CY2, true]], "after the Gate's yes, the token is asked as the requester with write true");
});
