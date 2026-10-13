// @ts-check
// What the identity state shows of one chain entry to the modules that read it (the door, a server's chain admission): the key, the age, and the flags that decide how far it is trusted. Nothing else of the entry.
// `via: "github"` and `confirmed: true` (kernel/identity/chain.js, github-signin) are passed through so core/relay/chain-admit.js limitedOf can hold an unconfirmed GitHub-added device to a newcomer's limits.

/** @param {any} e */
export const entryView = e => ({
  eid: e.eid, kind: e.kind, pub: e.pub, since: e.since, founder: e.founder === true,
  ...(e.held ? { held: e.held } : {}), ...(e.alg ? { alg: e.alg, ...(e.rp ? { rp: e.rp } : {}) } : {}), ...(e.enclave ? { enclave: e.enclave } : {}), ...(e.agree ? { agree: e.agree } : {}),
  ...(e.via === "github" ? { via: "github" } : {}), ...(e.confirmed === true ? { confirmed: true } : {}),
});
