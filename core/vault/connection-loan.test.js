// @ts-check
// A connection Ben lent to a chat's agent for a turn acts only on Ben's turns: while the loan is live, Cy's turn in the same chat, or a turn nobody is recorded as asking, is refused at the Vault's second check,
// even if the end call has not run. With no loan, or after it ends, the ordinary rules stand and nothing more is asked.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionTokens, connectionUrn } from "./connection-token.js";

const SPACE = "spc_x", BEN = "per_ben", CY = "per_cy", OWNER = "per_owner";

/** A chain the way the hub's second check sees it: the asking person's hop, then the agent's hop carrying the chat's thread. */
const chain = (/** @type {string} */ person, thread = "chat-1") => ({ hops: [{ actor: { kind: "person", id: person } }, { actor: { kind: "agent", id: "agt_kit" }, via: { thread } }] });

function rig() {
  const loans = new Set(["vault:cshare:per_ben:clio:agt_kit:turn:chat-1"]);
  const askers = new Map([["chat-1", BEN]]);
  const asked = /** @type {string[]} */ ([]);
  const kernel = {
    space: SPACE, owner: OWNER, chain: async (/** @type {any} */ m) => m.chain,
    // the kernel's rule for a hop: the agent holds the loan, and the other person here holds a share of her own (a second member is allowed by the kernel; the binding is the Vault's)
    authorize: async () => ({ effect: "allow" }),
    mint: { list: async ({ source }) => [...loans].filter(x => x.startsWith(source)).map(x => ({ source: x })) },
  };
  const tokens = new ConnectionTokens({ people: /** @type {any} */ ({}), kernel, askerOf: async t => { asked.push(t); return askers.get(t) || null; } });
  const ask = (/** @type {any} */ c, name = "clio") => tokens.allowed(BEN, name, false, { chain: c });
  return { tokens, ask, loans, askers, asked };
}

test("Ben's turn uses the loaned connection; Cy's later turn in the same chat is refused, and so is a turn with no recorded asker", async () => {
  const { ask, askers } = rig();
  assert.equal(await ask(chain(BEN)), true, "Ben's own turn");
  askers.set("chat-1", CY);
  assert.equal(await ask(chain(CY)), false, "Cy asks the next turn, the loan has not ended");
  assert.equal(await ask(chain(BEN)), false, "whoever the hops say, the turn running was Cy's");
  askers.delete("chat-1");
  assert.equal(await ask(chain(BEN)), false, "no recorded asker: refused");
});

test("another chat, another connection, and a call with no loan are not held to the lender", async () => {
  const { ask, askers, asked } = rig();
  askers.set("chat-1", CY); askers.set("chat-2", CY);
  assert.equal(await ask(chain(CY, "chat-2")), true, "a loan is for chat-1 only; the ordinary rules stand elsewhere");
  assert.equal(await ask(chain(CY, "chat-1"), "other"), true, "a connection not lent keeps the ordinary rules");
  assert.deepEqual(asked, [], "no loan, no question");
});

test("after the loan ends the ordinary rules stand again", async () => {
  const { ask, loans, askers } = rig();
  askers.set("chat-1", CY);
  assert.equal(await ask(chain(CY)), false);
  loans.clear();
  assert.equal(await ask(chain(CY)), true);
});

test("the address the loan guards is the connection's own", () => { assert.equal(connectionUrn(SPACE, BEN, "clio"), "vyre://spc_x/vault/per_ben/item/clio"); });
