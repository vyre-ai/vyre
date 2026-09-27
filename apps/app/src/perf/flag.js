// Whether the perf meter is on (ADR 0027, section 6). A pure helper, so node tests import it.

const KEY = "vyre.perf";

/**
 * ?perf=1 turns the meter on and remembers it on this device, ?perf=0 forgets it, and anything
 * else reads what was kept: the app added to the Home Screen opens at the manifest's start_url with no
 * query. Blocked storage (private mode) leaves the query to decide this page alone.
 * @param {string | undefined} search the page's location.search
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void } | undefined} store
 * @returns {boolean}
 */
export function perfFlag(search, store) {
  let asked = null;
  try {
    asked = typeof search === "string" ? new URLSearchParams(search).get("perf") : null;
  } catch {
    return false;
  }
  try {
    if (asked === "1") store?.setItem(KEY, "1");
    else if (asked === "0") store?.removeItem(KEY);
    else return store?.getItem(KEY) === "1";
  } catch {
    // Storage threw: the query still decides this page.
  }
  return asked === "1";
}
