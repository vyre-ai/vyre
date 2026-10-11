// @ts-check
// asker: a caller that only ASKS in the Vault. Claude's own session (mcp) and any label that is not the person (an agent's name, a thread claim, a guest) (`cli:agent:kit`, `tailnet:agent:kit`, `agent:kit`) are the agent, whatever surface the label
// rides on; what they ask for waits for a person. A module acts under its own rule and a person is the person. The kind of a label (callerKind) names the surface, not who is behind it, so a check that
// stops at "mcp" lets an agent with a person's surface label do what only the person may.
import { callerKind } from "../modules/index.js";
import { isPerson, modelKey } from "../../lib/caller.js";

/** @param {unknown} caller */
export const isAsker = caller => callerKind(/** @type {string} */ (caller)) === "mcp" || (callerKind(/** @type {string} */ (caller)) !== "module" && !isPerson(String(caller)));

/**
 * A model files a few grant requests at most: each shows on the owner's approvals list, and a flood is a way to get one approved unread. Counted per agent identity (modelKey: mcp:agent:kit and an agent label
 * on a person surface are one agent; every unnamed session is one), so a model does not get five per thread. Throws the refusal when the identity already has five waiting.
 * @param {any} db @param {unknown} caller
 */
export function requestCap(db, caller) {
  const mine = modelKey(String(caller));
  if (/** @type {any[]} */ (db.prepare("SELECT by FROM vault_grant_requests").all()).filter(r => modelKey(String(r.by)) === mine).length >= 5) throw new Error("the owner has not answered this caller's earlier requests yet: 5 are waiting, and the owner approves or denies those first (vault.pending lists them)");
}
