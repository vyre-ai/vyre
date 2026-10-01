// @ts-check
// caller: how the chrome module reads a caller label. The same two rules as core/modules (callerKind
// and agentClaim), kept here so the standalone package (`vyre-chrome`) carries no part of the
// daemon. caller.test.js compares the two so they cannot drift.

/** @param {any} caller */
const SURFACES = ["cli", "local", "deck", "capsule", "mobile"];

export const callerKind = caller => {
  const c = String(caller);
  if (c.startsWith("module:")) return "module";
  const base = c.replace(/[\s:](agent|thread):.*$/si, "");
  return base !== c && SURFACES.includes(base) ? "mcp" : base;
};

export const AGENT_CLAIM = /(?:^|[\s:])agent:([A-Za-z0-9_-]*)/i;

/** @param {any} caller */
export const agentClaim = caller => {
  const m = AGENT_CLAIM.exec(String(caller ?? ""));
  return m ? m[1] || "(unnamed)" : null;
};
