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
