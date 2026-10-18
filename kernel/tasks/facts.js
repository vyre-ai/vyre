// kernel/tasks/facts.js: what a hand-in is checked against, read ON THE CHAIN OF THE PERSON HANDING IN, through the gateway's read check: the record a urn names, and whether a urn of this Space or a relative drive path names
// something that is there. A record the doer may not read answers exactly as one that does not exist (null, then the same refusal), so a doer cannot learn what exists beyond their reach. A drive file is checked on its
// FORM only (a relative path, no "..", no scheme): the kernel cannot see the drive, so that is the doer's claim, as a note's text is. It reads and decides no grant, so it is not trusted base (kernel/size.test.js).
const URN = /^vyre:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

// ONE exception, and only for existence: the record the task is ABOUT, if the person who made the task could read it when they made it (`record_read`, written by the kernel at the request), and its project (which the request already checked the requester may read). The task names it and the doer is told it, so that it exists is no news, and a requester cannot use a task to make a doer's hand-in reveal a record the requester could not read; a doer handing in a draft of the very record it was given
// (an agent whose lend reaches the task but not the project's team seat) must not be refused for that. Its fields are still read on the doer's own chain, and every other address is.
/** @param {{ get(chain: any, type: string, id: string): Promise<any> }} records the gateway's records (every read is checked against the chain) @param {any} chain the person handing in @param {string} space @param {{ get(type: string, id: string): Promise<any> } | null} [store] the store, read as the kernel for the task's own subject only @param {any[]} [subjects] the addresses the task is about */
export function createFacts(records, chain, space, store = null, subjects = []) {
  const own = async (/** @type {string} */ u) => { const m = store && subjects.includes(u) ? URN.exec(u) : null; if (!m || m[1] !== space) return false; try { return Boolean(await store?.get(m[2], m[3])); } catch { return false; } };
  const read = async (/** @type {string} */ u) => { const m = typeof u === "string" ? URN.exec(u) : null; if (!m || m[1] !== space) return null; try { return (await records.get(chain, m[2], m[3])) || null; } catch { return null; } };
  return Object.freeze({
    record: read,
    exists: async (/** @type {string} */ u) => typeof u === "string" && u.length > 0 && u.length < 500 && !u.includes("..") && (URN.test(u) ? Boolean(await read(u)) || await own(u) : !u.startsWith("/") && !u.includes(":")),
  });
}
