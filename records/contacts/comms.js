// @ts-check
// A Communication belongs to every Contact on it, and a Contact has many Communications: many to many. Today the link is a child record,
// `communication-party`, one per (communication, contact). Nothing above this file knows that: callers get `{ communication, contact, participation }` rows from
// `communicationsOf` and `contactsOf`, so when the store grows a native many-to-many link (records' `links` kind) only this file changes.

const fail = (/** @type {string} */ message, code = "invalid") => Object.assign(new Error(message), { code });
const idOf = (/** @type {string} */ urn) => urn.split("/")[4];
const typeOf = (/** @type {string} */ urn) => urn.split("/")[3];

/**
 * @param {{ space: string, records: { query(chain: any, type: string, spec: any): Promise<any>, get(chain: any, type: string, id: string): Promise<any>, create(chain: any, type: string, data: any, opts?: any): Promise<any> } }} cfg
 */
export function createComms(cfg) {
  const urnOf = (/** @type {any} */ s, /** @type {string} */ type) => (typeof s === "string" ? s : s.urn ?? `vyre://${cfg.space}/${type}/${s.id}`);

  /** Put a contact on a communication. Idempotent: attaching the same pair again returns the first row. @param {any} chain
   * @param {string | { urn?: string, id?: string }} communication @param {string | { urn?: string, id?: string }} contact
   * @param {{ address?: string, participation?: string }} [opts] @returns {Promise<{ party: any, created: boolean }>} */
  async function attachContact(chain, communication, contact, opts = {}) {
    const cu = urnOf(communication, "communication"), pu = urnOf(contact, "contact");
    if (typeOf(cu) !== "communication" || typeOf(pu) !== "contact") throw fail("attachContact takes a communication and a contact");
    const key = `${idOf(cu)}:${idOf(pu)}`;
    const existing = async () => (await cfg.records.query(chain, "communication-party", { filter: { field: "key", op: "eq", value: key }, page: { limit: 1 } })).rows[0] ?? null;
    const had = await existing();
    if (had) return { party: had, created: false };
    const comm = await cfg.records.get(chain, "communication", idOf(cu));
    if (!comm) throw fail("no such communication", "not_found");
    try {
      const party = await cfg.records.create(chain, "communication-party", { key, communication: { urn: cu }, contact: { urn: pu }, occurred_at: comm.data.occurred_at, ...(opts.address ? { address: opts.address } : {}), ...(opts.participation ? { participation: opts.participation } : {}) });
      return { party, created: true };
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== "unique_violation") throw e;
      const now = await existing(); // another writer attached it first
      if (now) return { party: now, created: false };
      throw e;
    }
  }

  /** The timeline of one contact: its communications, newest first, one page at a time. Rows are `{ communication, participation, address, party }`; a communication this chain may not read is left out.
   * @param {any} chain @param {string | { urn?: string, id?: string }} contact @param {{ limit?: number, cursor?: string, kind?: string }} [opts] */
  async function communicationsOf(chain, contact, opts = {}) {
    const pu = urnOf(contact, "contact");
    const p = await cfg.records.query(chain, "communication-party", { filter: { field: "contact", op: "eq", value: { urn: pu } }, sort: [{ field: "occurred_at", dir: "desc" }], page: { limit: Math.min(opts.limit ?? 50, 200), ...(opts.cursor ? { cursor: opts.cursor } : {}) } });
    const rows = [];
    for (const party of p.rows) {
      const comm = await cfg.records.get(chain, "communication", idOf(party.data.communication.urn));
      if (!comm || (opts.kind && comm.data.kind !== opts.kind)) continue;
      rows.push({ communication: comm, participation: party.data.participation ?? null, address: party.data.address ?? null, party });
    }
    return { rows, ...(p.next_cursor ? { next_cursor: p.next_cursor } : {}) };
  }

  /** Everyone on one communication: `{ contact, participation, address, party }` rows. @param {any} chain @param {string | { urn?: string, id?: string }} communication */
  async function contactsOf(chain, communication) {
    const cu = urnOf(communication, "communication");
    const rows = [];
    let cursor;
    for (let guard = 0; guard < 10; guard++) {
      const p = await cfg.records.query(chain, "communication-party", { filter: { field: "communication", op: "eq", value: { urn: cu } }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      for (const party of p.rows) {
        const contact = await cfg.records.get(chain, "contact", idOf(party.data.contact.urn));
        if (contact) rows.push({ contact, participation: party.data.participation ?? null, address: party.data.address ?? null, party });
      }
      cursor = p.next_cursor;
      if (!cursor) break;
    }
    return rows;
  }

  /** The communication already logged for this source and id, or null (so a connector's re-delivery is not logged twice). @param {any} chain @param {string} source @param {string} sourceId */
  async function findBySource(chain, source, sourceId) {
    const p = await cfg.records.query(chain, "communication", { filter: { field: "source_key", op: "eq", value: `${source}:${sourceId}` }, page: { limit: 1 } });
    return p.rows[0] ?? null;
  }

  return { attachContact, communicationsOf, contactsOf, findBySource };
}
