// @ts-check
// caller: how the chrome module reads a caller label. The same two rules as core/modules (callerKind
// and agentClaim), kept here so the standalone package (`vyre-chrome`) carries no part of the
// daemon. caller.test.js compares the two so they cannot drift.

/** @param {any} caller */
export const callerKind = caller => {
  const c = String(caller);
  return c.startsWith("module:") ? "module" : c.replace(/[\s:](agent|thread):.*$/s, "");
};

export const AGENT_CLAIM = /(?:^|[\s:])agent:([A-Za-z0-9_-]*)/;

/** @param {any} caller */
export const agentClaim = caller => {
  const m = AGENT_CLAIM.exec(String(caller ?? ""));
  return m ? m[1] || "(unnamed)" : null;
};

/** The standalone package carries no daemon code, so this is the sanctioned copy of lib/person-surfaces.js PERSON_SURFACES; caller.test.js fails the day they differ. */
export const SURFACES = new Set(["cli", "local", "deck", "capsule"]);
const THREAD = /(?:^|[\s:])thread:/;

/**
 * The key a call is held to when it is not the person (lib/caller.js modelKey, kept here for the same reason as the rules above): the agent a named model claims, or `caller:<kind>` for anyone that names
 * no one (an unnamed `mcp` is every model's shell); null only for the person's own surface. Never null for `mcp` or `harness` in any form (MH-1).
 * @param {any} caller @returns {string|null}
 */
export const modelKey = caller => {
  const c = String(caller ?? "");
  const claim = agentClaim(c);
  if (claim) return claim;
  if (THREAD.test(c)) return `caller:${callerKind(c)}`;
  return SURFACES.has(callerKind(c)) ? null : `caller:${callerKind(c)}`;
};
