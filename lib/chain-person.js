// @ts-check
// lib/chain-person.js: the first PERSON on a verified chain, or null. Set by the kernel from the chain, never from what a request names: a task an agent hands on keeps the person it began with, so the woken
// agent works within that person's limits.

/** @param {any} chain @returns {string | null} */
export const requestedFor = chain => { const h = chain && Array.isArray(chain.hops) ? chain.hops.find((/** @type {any} */ x) => x.actor && x.actor.kind === "person") : null; return h ? String(h.actor.id) : null; };
