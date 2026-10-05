// @ts-check
// Everything said to a contact lands on the contact (team/0.3/DESIGN-contacts-comms.md, idea 3). These are the records-side pieces a "Log communications" Flow
// calls: find the contact an address belongs to, and write one Communication with who was on it as written and its contacts. Logging reads; nothing here sends.
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
 * The contact a handle belongs to, by the unique main email or phone, then by a contact point (one record per further address), or null. The legacy
 * `other_emails` and `other_phones` lists are not searched (a list cannot be indexed, and Twenty cannot filter one): new writers use `addContactPoint`.
 * @param {{ records: any }} kernel @param {any} chain @param {string} address @returns {Promise<{ urn: string, id: string } | null>}
 */
export async function findContact(kernel, chain, address) {
  const kind = kindOf(address);
  const value = kind === "email" ? normalizeEmail(address) : normalizePhone(address);
  if (!value) return null;
  const page = await kernel.records.query(chain, "contact", { filter: { field: kind, op: "eq", value }, page: { limit: 1 } });
  const r = page.rows[0];
  if (r) return { urn: r.urn, id: r.id };
  // not a main address: a contact point holds it
  const pt = (await kernel.records.query(chain, "contact_point", { filter: { field: "address", op: "eq", value }, page: { limit: 1 } })).rows[0];
  const u = pt && pt.data.contact && pt.data.contact.urn;
  return u ? { urn: u, id: u.split("/").pop() } : null;
}

/**
 * Give a contact one more way to be reached. The address is unique in the Space across main addresses and points: it is refused (`taken_by`) when it is another
 * contact's main email or phone or another contact's point, and a repeat for the same contact returns the point already there.
 * @param {{ records: any }} kernel @param {any} chain @param {string} contactUrn @param {string} address @param {string} [label]
 * @returns {Promise<{ point?: any, taken_by?: string, created: boolean }>}
 */
export async function addContactPoint(kernel, chain, contactUrn, address, label) {
  const kind = kindOf(address);
  const value = kind === "email" ? normalizeEmail(address) : normalizePhone(address);
  if (!value) throw Object.assign(new Error("an address or number is needed"), { code: "bad_input" });
  const owner = await findContact(kernel, chain, value);
  if (owner && owner.urn !== contactUrn) return { taken_by: owner.urn, created: false };
  const have = (await kernel.records.query(chain, "contact_point", { filter: { field: "address", op: "eq", value }, page: { limit: 1 } })).rows[0];
  if (have) return { point: have, created: false };
  const main = await kernel.records.get(chain, "contact", contactUrn.split("/").pop());
  if (main && main.data[kind] === value) return { created: false };
  try { return { point: await kernel.records.create(chain, "contact_point", { contact: { urn: contactUrn }, kind, address: value, ...(label ? { label } : {}) }), created: true }; }
  catch (e) { if (e && e.code === "unique_violation") { const o = await findContact(kernel, chain, value); return { taken_by: o ? o.urn : undefined, created: false }; } throw e; }
}

/** The Communication's text field for each way a person was on it (the way a person was on it). */
export const HOW_FIELD = Object.freeze({ from: "from", to: "to", cc: "cc", bcc: "bcc", organizer: "organizer", attendee: "attendees", caller: "from", callee: "to" });
const FIELD_HOW = Object.freeze({ from: "from", to: "to", cc: "cc", bcc: "bcc", organizer: "organizer", attendees: "attendee" });

/** The comma separated addresses of each role, from a list of { address, how }. @param {{ address: string, how: string }[]} people */
export function addressFields(people) {
  /** @type {Record<string, string[]>} */ const by = {};
  for (const p of people) { const k = HOW_FIELD[/** @type {keyof typeof HOW_FIELD} */ (p.how)]; if (!k) continue; (by[k] ||= []); if (!by[k].includes(p.address)) by[k].push(p.address); }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.join(", ")]));
}

/**
 * Log one communication and who was on it. The same item (`source_key`: the connector and its own id) is logged once, however many times this is called: the second
 * call returns the first record and adds any contact that is missing. Who was on it as written is kept in the Communication's own from, to, cc, bcc, organizer and attendees
 * (addresses, comma separated, matched or not), and the Contacts those addresses belong to are its `contacts` (the one relation). A contact is made for an address nobody has only
 * when `createUnknown` says so (off by default: the logging Flow's switch).
 * @param {{ records: any }} kernel @param {any} chain
 * @param {{ kind: string, direction?: string, at: string, subject?: string, excerpt?: string, body?: string, original_url?: string, thread?: string, source_key: string, mailbox?: string,
 *   record?: string, attrs?: { owner?: string, project?: string, sensitivity?: string }, people: { address: string, how: string, name?: string }[], createUnknown?: boolean }} item
 * @returns {Promise<{ communication: any, created: boolean, participants: { address: string, how: string, contact: string | null }[] }>}
 */
export async function logCommunication(kernel, chain, item) {
  const R = kernel.records;
  const people = item.people.map((p) => ({ ...p, address: kindOf(p.address) === "email" ? normalizeEmail(p.address) : normalizePhone(p.address) }));
  /** @type {{ address: string, how: string, contact: string | null }[]} */ const participants = [];
  /** @type {Map<string, string>} */ const contacts = new Map();
  for (const person of people) {
    let contact = await findContact(kernel, chain, person.address);
    if (!contact && item.createUnknown) {
      const k = kindOf(person.address);
      contact = await R.create(chain, "contact", { name: person.name || person.address, [k]: person.address }).then((/** @type {any} */ c) => ({ urn: c.urn, id: c.id }), async (/** @type {any} */ e) => { if (e && e.code === "unique_violation") return findContact(kernel, chain, person.address); throw e; });
    }
    if (contact) contacts.set(contact.urn, contact.urn);
    participants.push({ address: person.address, how: person.how, contact: contact ? contact.urn : null });
  }
  const data = { kind: item.kind, at: item.at, source_key: item.source_key,
    ...(item.direction ? { direction: item.direction } : {}), ...(item.subject ? { subject: item.subject } : {}), ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    ...(item.body ? { body: item.body } : {}), ...(item.original_url ? { original_url: item.original_url } : {}), ...(item.thread ? { thread: item.thread } : {}),
    ...(item.mailbox ? { mailbox: item.mailbox } : {}), ...(item.record ? { record: { urn: item.record } } : {}),
    ...addressFields(people), ...(contacts.size ? { contacts: [...contacts.keys()].map((urn) => ({ urn })) } : {}) };
  // Who may see it follows where it came through (kernel-2's visibility rule). The kernel attributes a grant can name today are owner, project and sensitivity: the caller
  // passes the ones it wants on the communication (`attrs`); a `source` attribute for the mailbox is kernel-2's to add.
  const opts = item.attrs ? { attrs: item.attrs } : {};
  let communication, created = true;
  try { communication = await R.create(chain, "communication", data, opts); }
  catch (e) {
    if (!e || e.code !== "unique_violation") throw e;
    created = false;
    communication = (await R.query(chain, "communication", { filter: { field: "source_key", op: "eq", value: item.source_key }, page: { limit: 1 } })).rows[0];
    if (!communication) throw e;
    // a second call after a failure fills in what is missing: the contacts not linked yet
    const have = new Set(((communication.data.contacts || [])).map((/** @type {any} */ c) => c.urn));
    const add = [...contacts.keys()].filter((u) => !have.has(u)).map((urn) => ({ urn }));
    if (add.length) communication = await R.update(chain, "communication", communication.id, { contacts: { add } }, communication.version);
  }
  return { communication, created, participants };
}

/** Every address a contact is reached at (lower case): the main email and phone and each contact point. @param {{ records: any }} kernel @param {any} chain @param {string} contactUrn */
async function addressesOf(kernel, chain, contactUrn) {
  const R = kernel.records, out = new Set();
  const c = await R.get(chain, "contact", contactUrn.split("/").pop());
  for (const k of ["email", "phone"]) if (c && c.data[k]) out.add(String(c.data[k]).toLowerCase());
  const pts = await R.query(chain, "contact_point", { filter: { field: "contact", op: "eq", value: { urn: contactUrn } }, page: { limit: 100 } });
  for (const p of pts.rows) if (p.data.address) out.add(String(p.data.address).toLowerCase());
  return out;
}

/**
 * Everything said to or by one contact, newest first: the communications whose `contacts` include them (the caller reads only what they may read), with how they were on each, read from
 * the Communication's own from, to, cc, organizer and attendees by the contact's addresses.
 * @param {{ records: any }} kernel @param {any} chain @param {string} contactUrn @param {number} [limit]
 */
export async function timelineOf(kernel, chain, contactUrn, limit = 50) {
  const R = kernel.records;
  const mine = await addressesOf(kernel, chain, contactUrn);
  const on = await R.linked(chain, contactUrn, { type: "communication", field: "contacts", limit: 200 });
  const out = [];
  for (const row of on.rows) {
    const c = row.record;
    if (!c) continue;
    let how = null;
    for (const [field, h] of Object.entries(FIELD_HOW)) {
      if (String(c.data[field] || "").toLowerCase().split(/\s*,\s*/).some((a) => mine.has(a))) { how = h; break; }
    }
    out.push({ how, communication: c });
  }
  out.sort((a, b) => String(b.communication.data.at).localeCompare(String(a.communication.data.at)));
  return out.slice(0, limit);
}
