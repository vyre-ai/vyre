// @ts-check
// shown: which watcher cards a thread has been shown, with the hash each card carried WHEN IT WAS SHOWN.
// The person's "turn it on" is recorded against that hash (lib/said/watchers.js), so what they agreed to
// is the code they saw. It is written when watchers.card or watchers.preset serves a card to a thread and
// never recomputed from the folder when read: an agent that shows card A, edits the folder, and waits for
// "turn it on" must not get its new hash recorded (reviewer-2). In memory only: after a restart no card
// counts as shown, which can only mean a yes is refused, never that one is spent on code unseen.

const MAX_THREADS = 200, MAX_PER_THREAD = 50;

export class ShownLog {
  /** @param {{ now?: () => number }} [o] */
  constructor({ now = Date.now } = {}) {
    this.now = now;
    /** @type {Map<string, Map<string, { name: string, hash: string, title: string|null, state: string, project: string, at: number }>>} */
    this.threads = new Map();
  }

  /** A card was served to `thread`: remember its name, hash and project exactly as served. */
  record(thread, { name, hash, title = null, state = "draft", project }) {
    if (!thread || !name || !hash || !project) return;
    const t = String(thread);
    let m = this.threads.get(t);
    if (!m) { m = new Map(); this.threads.set(t, m); }
    m.delete(name);                                  // newest last
    m.set(name, { name, hash, title, state, project, at: this.now() });
    while (m.size > MAX_PER_THREAD) m.delete(/** @type {string} */ (m.keys().next().value));
    this.threads.delete(t); this.threads.set(t, m);   // most recent thread last
    while (this.threads.size > MAX_THREADS) this.threads.delete(/** @type {string} */ (this.threads.keys().next().value));
  }

  /** What `thread` was shown: the newest entry per watcher, oldest first. Nothing is recomputed. */
  list(thread) {
    const m = this.threads.get(String(thread));
    return m ? [...m.values()].map(e => ({ ...e })) : [];
  }
}
