// @ts-check
// lib/within: the one way to race a promise against a clock.
//
// The timer is held (ref'd) until the promise answers or the limit passes, then cleared. A call that
// is waiting on it is live work: an unref'd timer let the event loop drain with the call still
// pending on macOS and Node 22, and the test runner then cancelled every later test in the file.
// Clearing it in `finally` means a prompt answer leaves nothing behind to hold the process open.

/**
 * The promise's answer, or `late` when it takes longer than `ms`.
 * @template T, L
 * @param {Promise<T> | T} p @param {number} ms @param {L} [late]
 * @returns {Promise<T | L>}
 */
export function within(p, ms, late = /** @type {any} */ (null)) {
  /** @type {any} */ let timer;
  const clock = new Promise(res => { timer = setTimeout(() => res(late), ms); });
  return Promise.race([p, clock]).finally(() => clearTimeout(timer));
}

/**
 * The promise's answer, or a rejection with `fail()` when it takes longer than `ms`.
 * @template T
 * @param {Promise<T> | T} p @param {number} ms @param {() => Error} fail
 * @returns {Promise<T>}
 */
export function withinOrThrow(p, ms, fail) {
  /** @type {any} */ let timer;
  const clock = new Promise((_, no) => { timer = setTimeout(() => no(fail()), ms); });
  return Promise.race([p, clock]).finally(() => clearTimeout(timer));
}
