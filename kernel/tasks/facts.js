// kernel/tasks/facts.js: what a hand-in is checked against, read from the store the kernel hands in: the record a urn names, and whether a urn of this Space or a relative drive path names something that is there.
// It reads and decides no grant (a record is read as the kernel, only to see whether a field is filled or a thing exists), so it is not trusted base (kernel/size.test.js). Without it a draft, a file or a fields
// hand-in is refused on a real server: the check had nothing to look at.
const URN = /^vyre:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

/** @param {{ get(type: string, id: string): Promise<any> }} store @param {string} space */
export function createFacts(store, space) {
  const read = async (/** @type {string} */ u) => { const m = typeof u === "string" ? URN.exec(u) : null; if (!m || m[1] !== space) return null; try { return (await store.get(m[2], m[3])) || null; } catch { return null; } };
  return Object.freeze({
    record: read,
    /** A urn of this Space is there when the store holds it; a drive path (relative, no "..") is the doer's claim, which the kernel cannot see, so it passes on its form alone. */
    exists: async (/** @type {string} */ u) => typeof u === "string" && u.length > 0 && u.length < 500 && !u.includes("..") && (URN.test(u) ? Boolean(await read(u)) : !u.startsWith("/") && !u.includes(":")),
  });
}
