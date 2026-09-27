// @ts-check
// backoff: how long to wait before the next reconnect (docs/adr/0029-resilience.md, R3).
// 2 s, doubling to 60 s, each wait moved up to 20 percent either way so a hundred devices that
// lost the box together do not all come back in the same second.

/**
 * @param {{ min?: number, max?: number, jitter?: number, random?: () => number }} [o]
 */
export function backoff({ min = 2_000, max = 60_000, jitter = 0.2, random = Math.random } = {}) {
  let next = min;
  return {
    /** The wait before this attempt; the one after is twice as long, up to `max`. */
    delay() {
      const d = next;
      next = Math.min(max, next * 2);
      return Math.round(d * (1 + jitter * (random() * 2 - 1)));
    },
    /** After a success, a network change or a wake: the next wait is `min` again. */
    reset() { next = min; },
  };
}
