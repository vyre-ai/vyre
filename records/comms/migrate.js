// @ts-check
// A Space made before the Participant type was dropped keeps its participant records. Each one said how a person was on a communication (from, to, cc, organizer, attendee ...), the address as
// written, and the contact it matched. That now lives on the Communication itself: the addresses in its from, to, cc, bcc, organizer and attendees text, and the matched contacts in its `contacts`
// relation. This moves them there once and idempotently (a communication is updated once however many participants it had; what is already on it is not repeated), then removes the
// participant records. Nothing is lost: the role, the address and the match all survive. A Space that never had the type has nothing to do.
import { HOW_FIELD } from "./log.js";

/**
 * @param {{ records: any }} kernel @param {any} chain @param {(m: string) => void} [log]
 * @returns {Promise<{ migrated: number, communications: number }>}
 */
export async function migrateParticipants(kernel, chain, log = () => {}) {
  const R = kernel.records;
  /** @type {Map<string, { how: string, address: string, contact: string | null, id: string, version: number }[]>} */ const by = new Map();
  let cursor, seen = 0;
  try {
    do {
      const page = await R.query(chain, "participant", { page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const r of page.rows) {
        const cu = r.data.communication && r.data.communication.urn;
        if (!cu) continue;
        (by.get(cu) || by.set(cu, []).get(cu))?.push({ how: String(r.data.how || ""), address: String(r.data.address || "").toLowerCase(), contact: r.data.contact && r.data.contact.urn || null, id: r.id, version: r.version });
        seen++;
      }
      cursor = page.next_cursor;
    } while (cursor);
  } catch (e) {
    // no participant type in this Space (a new one, or already cleaned): nothing to move
    if (e && (e.code === "not_found" || e.code === "no_such_type" || /no type|unknown type|no such type/i.test(String(e.message)))) return { migrated: 0, communications: 0 };
    throw e;
  }
  let communications = 0;
  for (const [cu, parts] of by) {
    const id = cu.split("/").pop() || "";
    const comm = await R.get(chain, "communication", id).catch(() => null);
    if (comm) {
      /** @type {Record<string, string>} */ const patch = {};
      for (const p of parts) {
        const field = HOW_FIELD[/** @type {keyof typeof HOW_FIELD} */ (p.how)];
        if (!field || !p.address) continue;
        const cur = String(patch[field] ?? comm.data[field] ?? "");
        if (!cur.toLowerCase().split(/\s*,\s*/).includes(p.address)) patch[field] = cur ? `${cur}, ${p.address}` : p.address;
      }
      const have = new Set((comm.data.contacts || []).map((/** @type {any} */ c) => c.urn));
      const add = [...new Set(parts.map((p) => p.contact).filter((u) => u && !have.has(u)))].map((urn) => ({ urn }));
      if (Object.keys(patch).length || add.length) {
        await R.update(chain, "communication", comm.id, { ...patch, ...(add.length ? { contacts: { add } } : {}) }, comm.version);
        communications++;
      }
    }
    // the communication is gone, or now holds it: the participant records have done their job
    for (const p of parts) { try { await R.remove(chain, "participant", p.id, p.version); } catch (e) { log(`participants: could not remove ${p.id}: ${e && /** @type {Error} */ (e).message}`); } }
  }
  if (seen) log(`participants: ${seen} participant records moved onto ${communications} communications`);
  return { migrated: seen, communications };
}
