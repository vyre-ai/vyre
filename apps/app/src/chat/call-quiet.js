// @ts-check
// A tool call that failed waits before it is tried again. Remounting a chat (a peer stream
// that drops and opens again) must not ask the server several times a second. A pinned
// assistant chat has a run's thread id, or it does not call a thread tool at all: the chat id
// is not a thread id.

const STEPS = [2_000, 8_000, 30_000, 120_000];
/** @type {Map<string, { n: number, until: number }>} */
const fails = new Map();

/** The run's thread id, or null when there is none or the id is the chat's own. @param {unknown} thread @param {unknown} [chat] */
export function threadOrSkip(thread, chat) {
  const t = typeof thread === "string" ? thread : "";
  if (!t) return null;
  if (typeof chat === "string" && chat && t === chat) return null;
  return t;
}

/** Milliseconds left on a key's backoff, or 0 when a call may go. @param {string} key @param {number} [now] */
export function quietLeft(key, now = Date.now()) {
  const f = fails.get(key);
  if (!f || f.until <= now) return 0;
  return f.until - now;
}

/** @param {string} key @param {number} [now] */
export function noteFailed(key, now = Date.now()) {
  const f = fails.get(key);
  const n = f ? f.n + 1 : 1;
  const wait = STEPS[Math.min(n - 1, STEPS.length - 1)];
  fails.set(key, { n, until: now + wait });
  return wait;
}

/** @param {string} key */
export function noteOk(key) { fails.delete(key); }

/**
 * Run fn unless this key is inside its backoff. A throw is a failure and starts the next wait.
 * Every result carries `skipped` and `ok`, so a caller can tell a wait from a failure.
 * @param {string} key @param {() => Promise<any>} fn @param {number} [now]
 * @returns {Promise<{ skipped: true, ok: false } | { skipped: false, ok: true, value: any } | { skipped: false, ok: false }>}
 */
export async function callQuiet(key, fn, now = Date.now()) {
  if (quietLeft(key, now) > 0) return { skipped: true, ok: false };
  try {
    const value = await fn();
    noteOk(key);
    return { skipped: false, ok: true, value };
  } catch {
    noteFailed(key, now);
    return { skipped: false, ok: false };
  }
}
