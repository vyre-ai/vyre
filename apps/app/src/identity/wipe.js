// @ts-check
// When the server says this device was removed, the device forgets everything it held: its keys, the pairing, what it cached, the outbox, the unlock session and its settings. This file is the part that does not
// depend on a platform: a list of steps run one after another, each allowed to fail without stopping the rest, and the one rule for what counts as "removed".

/** @typedef {{ name: string, run: () => Promise<void> }} WipeStep */

/** What a wipe must cover, by the name each platform's step list gives it (the tests hold every list to this). */
export const WIPE_COVERS = Object.freeze(["device keys", "pairing", "settings and pins", "recent views", "outbox", "cached app files", "unlock session"]);

/**
 * Only the relay's "device removed" answer counts: the owner took this device off the server. A refused sign-in (`denied`) does not, because a device that was locked after failed attempts, or whose session
 * simply lapsed, gets the same answer, and wiping it for that would lose a key for nothing. An unreachable server is not a removal either. @param {unknown} code
 */
export const isRemovedCode = (code) => code === "relay_removed";

/** Run every step, in order, whatever happens to the one before it. Answers what was wiped and what could not be, by name. @param {readonly WipeStep[]} steps @returns {Promise<{ done: string[], failed: { name: string, why: string }[] }>} */
export async function wipeAll(steps) {
  /** @type {string[]} */ const done = [];
  /** @type {{ name: string, why: string }[]} */ const failed = [];
  for (const s of steps) {
    try { await s.run(); done.push(s.name); } catch (e) { failed.push({ name: s.name, why: e instanceof Error ? e.message : String(e) }); }
  }
  return { done, failed };
}

export const REMOVED_NOTICE = "This device was removed from your Vyre, so it forgot everything it held. Pair it again to use it.";
