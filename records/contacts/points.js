// @ts-check
// Contact-points and matching. A person is found by how you reach them: every address is one `contact-point` record whose value is unique in the Space, so
// finding the contact for an address is one lookup and a second record for the same person cannot be made by the same address. Everything goes through the
// gateway's own calls, so each read and write is authorized, logged and checked like any other.

import { normalizeAddress } from "../../kernel/store/normal.js";

const fail = (/** @type {string} */ message, code = "invalid") => Object.assign(new Error(message), { code });
const ownerType = (/** @type {string} */ urn) => urn.split("/")[3];

/**
 * @param {{ space: string, records: { query(chain: any, type: string, spec: any): Promise<any>, create(chain: any, type: string, data: any, opts?: any): Promise<any> }, defaultCountry?: string }} cfg
 */
export function createPoints(cfg) {
  const norm = (/** @type {any} */ raw) => normalizeAddress(raw, { defaultCountry: cfg.defaultCountry });
  const urnOf = (/** @type {any} */ s) => (typeof s === "string" ? s : s.urn ?? `vyre://${cfg.space}/${s.type}/${s.id}`);

  /** The contact-point record that holds this address, or null. One lookup on the unique value. @param {any} chain @param {string} normal */
  async function lookup(chain, normal) {
    const p = await cfg.records.query(chain, "contact-point", { filter: { field: "value", op: "eq", value: normal }, page: { limit: 1 } });
    return p.rows[0] ?? null;
  }

  /** Find the contact-point for an address (any spelling), or null. @param {any} chain @param {string} raw */
  async function findPoint(chain, raw) {
    const n = norm(raw);
    return n ? lookup(chain, n.value) : null;
  }

  /**
   * Give a contact or organization a way of being reached. The address is normalised here (the store refuses anything else). If the address is already held by the
   * same owner this is a no-op that returns it; if another owner holds it, it throws `unique_violation`: two records for one person is exactly what this stops.
   * @param {any} chain @param {{ owner: string | { urn: string } | { type: string, id: string }, value: string, label?: string, primary?: boolean, verified?: boolean }} input
   * @returns {Promise<{ point: any, created: boolean }>}
   */
  async function addPoint(chain, input) {
    const n = norm(input.value);
    if (!n) throw fail(`"${input.value}" is not an email address or a phone number`);
    const owner = urnOf(input.owner);
    if (!["contact", "organization"].includes(ownerType(owner))) throw fail("a contact-point belongs to a contact or an organization");
    const held = await lookup(chain, n.value);
    const same = (/** @type {any} */ p) => p.data.owner?.urn === owner;
    if (held) { if (same(held)) return { point: held, created: false }; throw fail(`${n.value} already belongs to another record`, "unique_violation"); }
    const data = { kind: n.kind, value: n.value, owner: { urn: owner }, ...(input.label ? { label: input.label } : {}), ...(input.primary !== undefined ? { is_primary: input.primary } : {}), ...(input.verified ? { is_verified: true, verified_at: new Date().toISOString() } : {}) };
    try { return { point: await cfg.records.create(chain, "contact-point", data), created: true }; }
    catch (e) {
      if (/** @type {any} */ (e)?.code !== "unique_violation") throw e;
      const now = await lookup(chain, n.value); // lost a race: the other writer's record is the answer if it is the same owner
      if (now && same(now)) return { point: now, created: false };
      throw e;
    }
  }

  /**
   * The contacts a message's or event's participants are. Each address is normalised and looked up once on the unique contact-point value, and nothing is created.
   * `matches` has one entry per distinct address; `contacts` lists each contact once; an address held by an organization is reported on its match as `owner` but is
   * not a contact. `unmatched` is what no record holds (or what this chain may not read).
   * @param {any} chain @param {readonly (string | { address: string })[]} participants
   * @returns {Promise<{ matches: { address: string, value: string, kind: "email" | "phone", point: string, owner: string }[], contacts: string[], unmatched: string[], invalid: string[] }>}
   */
  async function matchParticipants(chain, participants) {
    /** @type {Map<string, string>} */ const distinct = new Map(); // normal value -> first spelling
    /** @type {string[]} */ const invalid = [];
    for (const p of participants) {
      const raw = typeof p === "string" ? p : p?.address;
      const n = norm(raw);
      if (!n) { if (typeof raw === "string" && raw.trim()) invalid.push(raw); continue; }
      if (!distinct.has(n.value)) distinct.set(n.value, raw);
    }
    const found = await Promise.all([...distinct.keys()].map((v) => lookup(chain, v)));
    /** @type {any[]} */ const matches = []; /** @type {string[]} */ const unmatched = [];
    [...distinct.entries()].forEach(([value, address], i) => {
      const pt = found[i];
      if (pt && pt.data.owner?.urn) matches.push({ address, value, kind: pt.data.kind, point: pt.urn, owner: pt.data.owner.urn });
      else unmatched.push(address);
    });
    const contacts = [...new Set(matches.filter((m) => ownerType(m.owner) === "contact").map((m) => m.owner))];
    return { matches, contacts, unmatched, invalid };
  }

  return { findPoint, addPoint, matchParticipants };
}
