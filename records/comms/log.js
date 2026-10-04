// @ts-check
// Everything said to a contact lands on the contact (team/0.3/DESIGN-contacts-comms.md, idea 3). These are the records-side pieces a "Log communications" Flow
// calls: find the contact an address belongs to, and write one Communication with a Participant for each person on it. Logging reads; nothing here sends.
// Everything goes through the kernel's records door, so grants, the log and sealing apply to what is written like any other record.

/** An address as it is stored: lower case and trimmed. @param {string} a */
export const normalizeEmail = (a) => String(a ?? "").trim().toLowerCase().replace(/^<|>$/g, "");

/** A phone number as it is stored: a plus and digits, nothing else. A number without a country code is kept as the digits it has. @param {string} a */
export function normalizePhone(a) {
  const s = String(a ?? "").trim();
  const digits = s.replace(/\D/g, "");
  return digits ? (s.startsWith("+") || s.startsWith("00") ? "+" + digits.replace(/^00/, "") : digits) : "";
}

/** A person's address is an email if it has an @, else a phone number. @param {string} a */
const kindOf = (a) => (String(a).includes("@") ? "email" : "phone");

/**
 * The contact a handle belongs to, by the unique main email or phone, or null. Addresses held only in a contact's `other_emails` or `other_phones` are not
 * searched here (a list cannot be indexed, and Twenty cannot filter one): add the address as the main one, or merge the contacts.
 * @param {{ records: any }} kernel @param {any} chain @param {string} address @returns {Promise<{ urn: string, id: string } | null>}
 */
export async function findContact(kernel, chain, address) {
  const kind = kindOf(address);
  const value = kind === "email" ? normalizeEmail(address) : normalizePhone(address);
  if (!value) return null;
  const page = await kernel.records.query(chain, "contact", { filter: { field: kind, op: "eq", value }, page: { limit: 1 } });
  const r = page.rows[0];
  return r ? { urn: r.urn, id: r.id } : null;
}

/**
 * Log one communication and who was on it. The same item (`source_key`: the connector and its own id) is logged once, however many times this is called: the second
 * call returns the first record and fills in any participant that is missing. A person whose address matches no contact keeps the address on the participant, and
 * a contact is made for them only when `createUnknown` says so (off by default: the logging Flow's switch).
 * @param {{ records: any }} kernel @param {any} chain
 * @param {{ kind: string, direction?: string, at: string, subject?: string, excerpt?: string, body?: string, original_url?: string, thread?: string, source_key: string, mailbox?: string,
 *   record?: string, attrs?: { owner?: string, project?: string, sensitivity?: string }, people: { address: string, how: string, name?: string }[], createUnknown?: boolean }} item
 * @returns {Promise<{ communication: any, created: boolean, participants: { address: string, how: string, contact: string | null }[] }>}
 */
export async function logCommunication(kernel, chain, item) {
  const R = kernel.records;
  const data = { kind: item.kind, at: item.at, source_key: item.source_key,
    ...(item.direction ? { direction: item.direction } : {}), ...(item.subject ? { subject: item.subject } : {}), ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    ...(item.body ? { body: item.body } : {}), ...(item.original_url ? { original_url: item.original_url } : {}), ...(item.thread ? { thread: item.thread } : {}),
    ...(item.mailbox ? { mailbox: item.mailbox } : {}), ...(item.record ? { record: { urn: item.record } } : {}) };
  // Who may see it follows where it came through (kernel-2's visibility rule). The kernel attributes a grant can name today are owner, project and sensitivity: the caller
  // passes the ones it wants on the communication and its participants (`attrs`); a `source` attribute for the mailbox is kernel-2's to add.
  const opts = item.attrs ? { attrs: item.attrs } : {};
  let communication, created = true;
  try { communication = await R.create(chain, "communication", data, opts); }
  catch (e) {
    if (!e || e.code !== "unique_violation") throw e;
    created = false;
    communication = (await R.query(chain, "communication", { filter: { field: "source_key", op: "eq", value: item.source_key }, page: { limit: 1 } })).rows[0];
    if (!communication) throw e;
  }
  // who is on it already (a second call after a failure fills in only what is missing)
  const have = new Set();
  if (!created) {
    let cursor;
    do {
      const p = await R.query(chain, "participant", { filter: { field: "communication", op: "eq", value: { urn: communication.urn } }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      for (const r of p.rows) have.add(`${r.data.how}|${r.data.address ?? ""}`);
      cursor = p.next_cursor;
    } while (cursor);
  }
  const participants = [];
  for (const person of item.people) {
    const address = kindOf(person.address) === "email" ? normalizeEmail(person.address) : normalizePhone(person.address);
    let contact = await findContact(kernel, chain, address);
    if (!contact && item.createUnknown) {
      const k = kindOf(address);
      contact = await R.create(chain, "contact", { name: person.name || address, [k]: address }).then((/** @type {any} */ c) => ({ urn: c.urn, id: c.id }), async (/** @type {any} */ e) => { if (e && e.code === "unique_violation") return findContact(kernel, chain, address); throw e; });
    }
    if (!have.has(`${person.how}|${address}`)) await R.create(chain, "participant", { communication: { urn: communication.urn }, how: person.how, address, ...(contact ? { contact: { urn: contact.urn } } : {}) }, opts);
    participants.push({ address, how: person.how, contact: contact ? contact.urn : null });
  }
  return { communication, created, participants };
}

/**
 * Everything said to or by one contact, newest first: the communications they were on, through their participant records (the caller reads only what they may read).
 * @param {{ records: any }} kernel @param {any} chain @param {string} contactUrn @param {number} [limit]
 */
export async function timelineOf(kernel, chain, contactUrn, limit = 50) {
  const R = kernel.records;
  const on = await R.query(chain, "participant", { filter: { field: "contact", op: "eq", value: { urn: contactUrn } }, page: { limit: 200 } });
  const out = [];
  for (const p of on.rows) {
    const u = p.data.communication && p.data.communication.urn;
    const id = u && u.split("/").pop();
    const c = id ? await R.get(chain, "communication", id) : null;
    if (c) out.push({ how: p.data.how, communication: c });
  }
  out.sort((a, b) => String(b.communication.data.at).localeCompare(String(a.communication.data.at)));
  return out.slice(0, limit);
}
