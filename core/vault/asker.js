// @ts-check
// asker: a caller that only ASKS in the Vault. Claude's own session (mcp) and any label that is not the person (an agent's name, a thread claim, a guest) (`cli:agent:kit`, `tailnet:agent:kit`, `agent:kit`) are the agent, whatever surface the label
// rides on; what they ask for waits for a person. A module acts under its own rule and a person is the person. The kind of a label (callerKind) names the surface, not who is behind it, so a check that
// stops at "mcp" lets an agent with a person's surface label do what only the person may.
import { callerKind } from "../modules/index.js";
import { isPerson } from "../../lib/caller.js";

/** @param {unknown} caller */
export const isAsker = caller => callerKind(/** @type {string} */ (caller)) === "mcp" || (callerKind(/** @type {string} */ (caller)) !== "module" && !isPerson(String(caller)));
