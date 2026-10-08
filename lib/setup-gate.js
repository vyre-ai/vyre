// @ts-check
// setup-gate: what the setup channel (the setup page before the box is claimed) may call, as one list. Pure data and one predicate with no import: the relay's gate (core/relay/setup.js) and the registry's two checks of a
// setup caller (core/modules, kernel/retrofit/gates.js) all read it from here, so no part has to import another to agree on it.

/**
 * Exactly what the setup channel may call (condition 3, tailnet plan 3.6b). Any addition is posted
 * in the team's CHAT.md and added to the plan first. `relay.pair.ticket` is REFUSED here since 4 Oct (one pairing path); it was allowed once, by the
 * gate below; `relay.setup.end` and `relay.setup.begin` are internal tools and never reachable
 * from a channel, whatever this list says.
 */
export const SETUP_TOOLS = Object.freeze(new Set([
  "relay.setup.status", "wink.server.setup-offer", "link.health", "system.info",
]));
/** Families of tools the channel may call, by exact name: none now (the network step is gone with the old setup page). */
export const SETUP_TOOL_FAMILIES = Object.freeze(/** @type {RegExp[]} */ ([]));
/**
 * Why each of those may be called, by exact name: the fixed tools and the family's one tool. The registry's own check of a setup caller (core/modules/agent-reach.js SETUP_REACH) is
 * built from this map and asks setupToolAllowed below, so the relay's gate and the registry's gates read one list: a tool added above and left out here is refused by a test, not by a
 * person's setup page ("no tool network.wink.status", IR-11).
 * @type {ReadonlyMap<string, string>}
 */
export const SETUP_REASONS = new Map([
  ["relay.setup.status", "the app reads its own setup session: the four check words"],
  ["wink.server.setup-offer", "the app asks the unowned server for its pairing ticket, for the app's own identity"],
  ["link.health", "reads whether the server is reachable"],
  ["system.info", "reads what machine this is, and how much memory it has for Records"],
]);
/** The events the setup page may follow, one type per stream. */
export const SETUP_EVENTS = Object.freeze(new Set(["relay.paired"]));

// Tools added later (the sessions sign-in tool, for "Sign in to your AI") come from the registry,
// not from a call: a shipped module lists them under "setupTools" in its module.json. Nothing under
// relay., presence. or vault. is ever taken, so a module cannot widen the channel into pairing,
// presence or secrets.
/**
 * May the setup channel call this tool? The fixed list above, or a tool a shipped module declared
 * under "setupTools" in its module.json (`extra`, read from the registry by the caller; the loader
 * only honours the field for shipped modules). Never a relay, presence or vault tool.
 * @param {string} name @param {readonly string[]} [extra]
 */
export const setupToolAllowed = (name, extra = []) => SETUP_TOOLS.has(name) || SETUP_TOOL_FAMILIES.some(r => r.test(name)) || (extra.includes(name) && !/^(relay|presence|vault)\./.test(name));
