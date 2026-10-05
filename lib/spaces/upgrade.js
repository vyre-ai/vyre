// @ts-check
// lib/spaces/upgrade: carrying a Personal space to My Cloud (the user's ruling, 5 Oct). The person's own device holds both Spaces' gateways (the Personal kernel it runs, and My Cloud over the paired
// session), so it is the courier: a Personal space has no Drive of gigabytes, so nothing here needs the server-to-server pull the project move uses. One approval covers everything, and the plan hash
// the person approves covers the types, the exact records (id and version) and what chats and memory report.
//   const plan = await planUpgrade({ local, to, ports })       read only: what would move, what cannot, and the hash the approval is bound to
//   const report = await runUpgrade({ plan, local, remote, ports })   defines the missing types, copies records (ids kept, two passes so links never point at a record not there yet), verifies, then chats
//                                                                      and memory through their ports; answers what moved and, by name, anything that did not
// A side is { space, records, definitions, chain }: a gateway's records, its `definitions`, and the person's chain in THAT Space. Sealed fields cannot be copied by this code (it never sees a value): a record with one moves without it and
// the report names it. `ports.chats` and `ports.memory` are `{ plan(), move({ to }) }`: their data is sealed with keys that do not change, so they move as ciphertext through their own teams' code.
import crypto from "node:crypto";
import { isSealedValue } from "../sealed.js";

const PAGE = 100;
const canonical = (/** @type {any} */ v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const hashOf = (/** @type {any} */ v) => crypto.createHash("sha256").update(canonical(v)).digest("base64url");
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const linkValue = (/** @type {any} */ v) => Boolean(v) && typeof v === "object" && !Array.isArray(v) && typeof v.urn === "string";

/** The record types an upgrade carries: every type the Space defines that is not the kernel's own bookkeeping. @param {any} t */
const carried = (t) => t && typeof t.name === "string" && t.protected !== true && t.hidden !== true;

/** Types in an order where a link's target type comes before the type that links to it, as far as the links allow (the second pass settles the rest). @param {any[]} types */
function orderTypes(types) {
  const names = new Set(types.map(t => t.name));
  /** @type {string[]} */ const out = [];
  const seen = new Set();
  const visit = (/** @type {any} */ t) => {
    if (seen.has(t.name)) return;
    seen.add(t.name);
    for (const f of t.fields || []) if (f.kind === "link" && typeof f.to === "string" && names.has(f.to)) { const d = types.find(x => x.name === f.to); if (d) visit(d); }
    out.push(t.name);
  };
  for (const t of types) visit(t);
  return out.map(n => types.find(t => t.name === n));
}

/** Every row of a type under the person's chain, in pages. @param {any} side @param {string} type */
async function* rowsOf(side, type) {
  let cursor;
  for (;;) {
    const p = await side.records.query(side.chain, type, { page: { limit: PAGE, ...(cursor ? { cursor } : {}) } });
    for (const r of p.rows) yield r;
    if (!p.next_cursor) break;
    cursor = p.next_cursor;
  }
}

/**
 * What would move, read only. The hash covers both Spaces, the types and every record's id and version, and what chats and memory say they would carry, so what the person approves is exactly this.
 * @param {{ local: any, to: string, ports?: { chats?: any, memory?: any }, include?: (t: any) => boolean }} o
 */
export async function planUpgrade({ local, to, ports = {}, include = carried }) {
  const defs = (await local.definitions(local.chain)).filter(include);
  /** @type {{ name: string, count: number, ids: string[] }[]} */ const types = [];
  /** @type {string[]} */ const blockers = [];
  /** @type {string[]} */ const sealed = [];
  for (const t of orderTypes(defs)) {
    /** @type {string[]} */ const ids = [];
    for await (const r of rowsOf(local, t.name)) { ids.push(`${r.id}@${r.version}`); for (const [k, v] of Object.entries(r.data || {})) if (isSealedValue(v)) sealed.push(`${t.name}/${r.id}: ${k}`); }
    types.push({ name: t.name, count: ids.length, ids: ids.sort() });
  }
  const chats = ports.chats ? await ports.chats.plan() : null;
  const memory = ports.memory ? await ports.memory.plan() : null;
  for (const [what, p] of /** @type {[string, any][]} */ ([["chats", chats], ["memory", memory]])) if (p && Array.isArray(p.blockers)) for (const b of p.blockers) blockers.push(`${what}: ${b}`);
  const counts = { records: Object.fromEntries(types.map(t => [t.name, t.count])), total: types.reduce((n, t) => n + t.count, 0), ...(chats ? { chats: chats.counts ?? null } : {}), ...(memory ? { memory: memory.counts ?? null } : {}) };
  const hash = hashOf({ from: local.space, to, types: types.map(t => ({ name: t.name, ids: t.ids })), chats: chats && chats.counts, memory: memory && memory.counts });
  return { from: local.space, to, hash, counts, types: types.map(t => ({ name: t.name, count: t.count })), sealed, blockers };
}

/** A link value with its Space segment turned from the Personal space to My Cloud (ids are kept). @param {any} v @param {string} from @param {string} to */
function rewrite(v, from, to) {
  const one = (/** @type {any} */ x) => (linkValue(x) ? { ...x, urn: String(x.urn).replace(`vyre://${from}/`, `vyre://${to}/`) } : x);
  return Array.isArray(v) ? v.map(one) : one(v);
}

/**
 * Carry it. Idempotent: a record already in My Cloud (same id) is left and counted, so a stopped upgrade resumes. @param {{ plan: any, local: any, remote: any, ports?: { chats?: any, memory?: any }, include?: (t: any) => boolean }} o
 * @returns {Promise<{ moved: { records: Record<string, number>, chats?: any, memory?: any }, notMoved: { what: string, why: string }[], recordsComplete: boolean }>}
 */
export async function runUpgrade({ plan, local, remote, ports = {}, include = carried }) {
  if (!plan || plan.from !== local.space || plan.to !== remote.space) throw err("bad_input", "that plan is not for these two spaces");
  if (plan.blockers && plan.blockers.length) throw err("blocked", `the upgrade cannot start: ${plan.blockers.join("; ")}`);
  /** @type {{ what: string, why: string }[]} */ const notMoved = [];
  /** @type {Record<string, number>} */ const moved = {};
  const defs = (await local.definitions(local.chain)).filter(include);
  const have = new Set((await remote.definitions(remote.chain)).map((/** @type {any} */ t) => t.name));
  const add = defs.filter((/** @type {any} */ t) => !have.has(t.name));
  if (add.length) await remote.records.define(remote.chain, { add_types: add }, {});
  // pass 1: every record, ids kept, with its link fields left out (a link to a record not copied yet would be refused)
  /** @type {{ type: string, id: string, links: Record<string, any> }[]} */ const withLinks = [];
  for (const t of orderTypes(defs)) {
    const linkFields = new Set((t.fields || []).filter((/** @type {any} */ f) => f.kind === "link").map((/** @type {any} */ f) => f.name));
    moved[t.name] = 0;
    for await (const r of rowsOf(local, t.name)) {
      const exists = await remote.records.get(remote.chain, t.name, r.id).catch(() => null);
      /** @type {Record<string, any>} */ const data = {};
      /** @type {Record<string, any>} */ const links = {};
      for (const [k, v] of Object.entries(r.data || {})) {
        if (isSealedValue(v)) { notMoved.push({ what: `${t.name}/${r.id}.${k}`, why: "a sealed value stays with its sealing process; the record moved without it" }); continue; }
        if (linkFields.has(k)) { if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) links[k] = rewrite(v, local.space, remote.space); continue; }
        data[k] = v;
      }
      if (!exists) {
        const a = (local.records.attrsOf && local.records.attrsOf(`vyre://${local.space}/${t.name}/${r.id}`)) || {};
        const attrs = Object.fromEntries(["owner", "project", "sensitivity"].filter(k => typeof a[k] === "string").map(k => [k, a[k]]));
        try { await remote.records.create(remote.chain, t.name, data, { import: true, id: r.id, ...(Object.keys(attrs).length ? { attrs } : {}) }); }
        catch (e) { notMoved.push({ what: `${t.name}/${r.id}`, why: String(/** @type {Error} */ (e).message).slice(0, 120) }); continue; }
      }
      moved[t.name]++;
      if (Object.keys(links).length) withLinks.push({ type: t.name, id: r.id, links });
    }
  }
  // pass 2: the links, now that every record is there
  for (const l of withLinks) {
    try {
      const cur = await remote.records.get(remote.chain, l.type, l.id);
      const patch = Object.fromEntries(Object.entries(l.links).filter(([k, v]) => canonical(cur.data[k]) !== canonical(v)));
      if (Object.keys(patch).length) await remote.records.update(remote.chain, l.type, l.id, patch, cur.version);
    } catch (e) { notMoved.push({ what: `${l.type}/${l.id} links`, why: String(/** @type {Error} */ (e).message).slice(0, 120) }); }
  }
  // verify against the plan: every planned record is in My Cloud now
  for (const t of plan.types) {
    let n = 0;
    for await (const r of rowsOf(remote, t.name)) { void r; n++; }
    if (n < t.count) notMoved.push({ what: `${t.name}`, why: `${t.count - n} of ${t.count} are not in My Cloud` });
  }
  /** @type {any} */ const out = { moved: { records: moved }, notMoved, recordsComplete: !notMoved.some(n => !/sealed value stays/.test(n.why)) };
  if (ports.chats) { try { out.moved.chats = await ports.chats.move({ to: remote.space }); } catch (e) { notMoved.push({ what: "chats", why: String(/** @type {Error} */ (e).message).slice(0, 120) }); } }
  if (ports.memory) { try { out.moved.memory = await ports.memory.move({ to: remote.space }); } catch (e) { notMoved.push({ what: "memory", why: String(/** @type {Error} */ (e).message).slice(0, 120) }); } }
  return out;
}
