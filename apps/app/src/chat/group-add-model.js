// @ts-check
// Add people to a group chat over work.chat.add-people: the tool wants a key ring for every thread in the chat, made on this device. Ask once to learn which threads are missing a ring, make those rings, ask again.
// It stops when the answer is done, when this device cannot make a ring, or after a few rounds (a thread that never takes its ring).

const ROUNDS = 4;

/**
 * @param {(tool: string, input: Record<string, unknown>) => Promise<any>} call
 * @param {string} chat a thread id of the group
 * @param {string[]} people person ids to add
 * @param {(thread: string) => Promise<{ ring: any } | { say: string }>} ringFor the ring of one thread with the newcomers, or the line to show
 * @returns {Promise<string | null>} null when it is done, else the line to show
 */
export async function addToGroup(call, chat, people, ringFor) {
  /** @type {Record<string, any>} */ const rings = {};
  for (let round = 0; round < ROUNDS; round++) {
    const r = await call("work.chat.add-people", { chat, people, rings });
    if (r?.done) return null;
    const failed = Array.isArray(r?.failed) ? r.failed : [];
    if (failed.length) return `Some threads could not take them: ${failed.map((/** @type {any} */ f) => `${f.thread} (${f.error})`).join(", ")}`;
    const missing = Array.isArray(r?.missing_rings) ? r.missing_rings.map(String) : [];
    if (!missing.length) return null;
    for (const thread of missing) {
      const made = await ringFor(thread);
      if ("say" in made) return made.say;
      rings[thread] = made.ring;
    }
  }
  return "They could not be added to every thread. Try again in a moment.";
}
