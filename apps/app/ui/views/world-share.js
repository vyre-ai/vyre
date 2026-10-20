// @ts-check
// One records world per filter, shared by every screen that reads it (ui/views/data.ts useRecordsWorld): Records, the record page in its side panel, a type's Access tab and the new
// record form used to read every type, every page, each for itself. Pure scheduling, so it is tested without React:
//   - one read at a time; a change during a read runs once after it (never a pile of reads)
//   - a change that names its type (a record written here, or a record event from the box) re-reads that type only
//   - a box event that may not touch records waits SOON_MS and reads once for the whole burst
//   - the last world stays while it is read again, and stays after the last screen leaves, so the next one draws it at once and reads behind it

/** How long a burst of box events is gathered before the world is read once. */
export const SOON_MS = 1500;

/**
 * @template W
 * @param {{ readAll: () => Promise<W>, readTypes: (prev: W, types: string[]) => Promise<W>, has: (w: W, type: string) => boolean, wait?: (f: () => void, ms: number) => unknown }} o
 */
export function createShare(o) {
  const wait = o.wait ?? ((/** @type {() => void} */ f, /** @type {number} */ ms) => setTimeout(f, ms));
  /** @type {W | undefined} */ let data;
  /** @type {Error | null} */ let error = null;
  let loading = true;
  /** @type {Promise<void> | null} */ let running = null;
  /** @type {"full" | Set<string> | null} */ let queued = null;
  let soon = false;
  /** @type {Set<() => void>} */ const subs = new Set();
  let reads = 0;

  const emit = () => { for (const f of [...subs]) { try { f(); } catch { /* one screen's redraw must not stop the others */ } } };
  /** @param {"full" | Set<string>} a @param {"full" | Set<string>} b @returns {"full" | Set<string>} */
  const merge = (a, b) => (a === "full" || b === "full" ? "full" : new Set([...a, ...b]));

  /** @param {"full" | Set<string>} what @returns {Promise<void>} */
  function go(what) {
    if (running) { queued = queued ? merge(queued, what) : what; return running; }
    running = (async () => {
      try {
        if (what === "full" || data === undefined) { reads++; data = await o.readAll(); }
        else {
          const prev = data;
          const known = [...what].filter((t) => o.has(prev, t));
          if (known.length) { reads++; data = await o.readTypes(prev, known); }
        }
        error = null;
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
      } finally {
        loading = false;
        running = null;
        emit();
        if (queued) { const q = queued; queued = null; void go(q); }
      }
    })();
    return running;
  }

  return {
    /** What a screen draws: the last good world (kept while it is read again), the last error, and whether no answer has come yet. */
    state: () => ({ data, error, loading: loading && data === undefined }),
    /**
     * A screen arrives: it is told of every new answer. The first screen after none reads the world (again, behind the one kept); a second screen while others are here shares
     * what they have, since the store's changes already keep it current. @param {() => void} f
     */
    subscribe(f) {
      const first = subs.size === 0;
      subs.add(f);
      if (!running && (data === undefined || first)) void go("full");
      return () => { subs.delete(f); };
    },
    /** The store changed. @param {{ type?: string, soon?: boolean } | undefined} h */
    changed(h) {
      if (h && typeof h.type === "string" && h.type) { void go(new Set([h.type])); return; }
      if (h && h.soon) {
        if (soon) return;
        soon = true;
        wait(() => { soon = false; void go("full"); }, SOON_MS);
        return;
      }
      void go("full");
    },
    reload: () => go("full"),
    /** How many reads were made (for the tests). */
    reads: () => reads,
    users: () => subs.size,
  };
}
