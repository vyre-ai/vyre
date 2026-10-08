// @ts-check
// agent login tools (ADR 0028, decision 2): lend one login to one agent for one origin, list and
// revoke those grants, and read the log of every use. Giving needs a person (from Claude it waits
// for vault.approve); taking away and reading names never does. No tool here returns a value or
// a username, and modules may not lend logins at all.

import { presence } from "./presence.js";
import { callerKind, agentClaim } from "../../modules/index.js";
import { parseExpiry } from "../vault.js";

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const int = { type: "integer" };

/**
 * @param {{ vault: import("../vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ vault, tool }) {
  const people = ["cli", "local", "deck", "capsule"];

  tool("vault.agent.grant", [...people, "mcp"], "Let one agent sign in to one site with one login, through vyred's fill of its computer. The agent never reads the login. From Claude it waits for a person to approve it.",
    obj({ agent: str, item: str, origin: str, expires: str }, ["agent", "item", "origin"]),
    ({ agent, item, origin, expires }, { caller }) => {
      if (callerKind(caller) === "module") throw new Error("modules cannot lend logins to agents");
      return vault.agents.grant({ agent, item, origin, expires: parseExpiry(expires) }, caller, callerKind(caller) === "mcp");
    },
    // From Claude a grant only waits as pending, and approving it needs a person, so the proof is skipped there.
    presence("Let an agent sign in with a vault login", input => vault.agents.summary(input, parseExpiry),
      { skip: ({ caller }) => callerKind(caller) === "mcp" }));

  tool("vault.agent.grants", ["cli", "local", "deck", "capsule", "device", "module", "mcp", "harness"], "Agent logins, active, pending, expired and revoked, with the last use and a use count. Names and origins only.",
    obj({ agent: str, item: str }), (input, { caller } = {}) => {
      // A model reads only its own agent's logins; a model that names no agent has none to read.
      if (["mcp", "harness"].includes(callerKind(caller))) {
        const own = agentClaim(String(caller || ""));
        if (!own) throw Object.assign(new Error("a model session that names no agent has no agent logins to list"), { code: "denied" });
        return vault.agents.list({ ...input, agent: own });
      }
      return vault.agents.list(input);
    });

  tool("vault.agent.revoke", null, "Take an agent login away. Needs no one: taking access away is always allowed.",
    obj({ id: str }, ["id"]), (input, { caller }) => vault.agents.revoke(input, caller));

  tool("vault.uses", ["cli", "local", "deck", "capsule", "device", "module"], "Every use of an item: when, which item, which agent or device, which origin and surface, and whether it was allowed. Never a value.",
    obj({ item: str, agent: str, since: { description: "ms since epoch or an ISO date" }, limit: int }), input => vault.agents.uses(input));
}
