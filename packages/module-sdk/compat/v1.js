// @ts-check
// The module contract 1 adapter (ADR 0047 section 8). Today contract 1 is the one the loader
// speaks, so this is the identity: the manifest and the ctx pass through unchanged. When contract
// 2 ships, this file translates a "vyre": "1" module's manifest onto 2 and gives it the ctx it was
// written against, so it runs unchanged. The loader and the testing harness route every
// "vyre": "1" module through it today, so the seam is exercised from the start.

/** The contract major this adapter serves. */
export const major = 1;

/** A v1 manifest as the running contract reads it. @param {any} m @returns {any} */
export const manifest = m => m;

/** The ctx a v1 module gets, from the running contract's. @template T @param {T} ctx @returns {T} */
export const context = ctx => ctx;
