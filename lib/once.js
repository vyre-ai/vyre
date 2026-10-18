// @ts-check
// once: a loader run on first use, its answer kept. If the loader throws, nothing is kept: the next call runs it again and throws its real error again, so a failed first load never turns into an undefined answer.

/** @template T @param {() => T} load @returns {() => T} */
export function once(load) {
  /** @type {T | undefined} */ let value;
  let done = false;
  return () => {
    if (done) return /** @type {T} */ (value);
    value = load();
    done = true;
    return /** @type {T} */ (value);
  };
}
