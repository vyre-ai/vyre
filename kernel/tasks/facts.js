// kernel/tasks/facts.js: what a hand-in is checked against, read ON THE CHAIN OF THE PERSON HANDING IN, through the gateway's read check: the record a urn names, and whether a urn of this Space or a relative drive path names
// something that is there. A record the doer may not read answers exactly as one that does not exist (null, then the same refusal), so a doer cannot learn what exists beyond their reach. A drive file is checked on its
// FORM only (a relative path, no "..", no scheme): the kernel cannot see the drive, so that is the doer's claim, as a note's text is. It reads and decides no grant, so it is not trusted base (kernel/size.test.js).
const URN = /^vyre:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

/** @param {{ get(chain: any, type: string, id: string): Promise<any> }} records the gateway's records (every read is checked against the chain) @param {any} chain the person handing in @param {string} space */
export function createFacts(records, chain, space) {
  const read = async (/** @type {string} */ u) => { const m = typeof u === "string" ? URN.exec(u) : null; if (!m || m[1] !== space) return null; try { return (await records.get(chain, m[2], m[3])) || null; } catch { return null; } };
  return Object.freeze({
    record: read,
    exists: async (/** @type {string} */ u) => typeof u === "string" && u.length > 0 && u.length < 500 && !u.includes("..") && (URN.test(u) ? Boolean(await read(u)) : !u.startsWith("/") && !u.includes(":")),
  });
}
