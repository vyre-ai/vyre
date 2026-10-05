// @ts-check
// lib/spaces/upgrade: carrying a Personal space to My Cloud (the user's ruling, 5 Oct). The person's own device holds both Spaces' gateways (the Personal kernel it runs, and My Cloud over the paired
// session), so it is the courier: a Personal space has no Drive of gigabytes, so nothing here needs the server-to-server pull the project move uses. One approval covers everything, and the plan hash
// the person approves covers the types, the exact records (id and version) and what chats and memory report.
//   const plan = await planUpgrade({ local, to, ports })       read only: what would move, what cannot, and the hash the approval is bound to
//   const report = await runUpgrade({ plan, local, remote, ports })   defines the missing types, copies records (ids kept, two passes so links never point at a record not there yet), verifies, then chats
//                                                                      and memory through their ports; answers what moved and, by name, anything that did not
// SEALED fields (a record's most sensitive values) are carried SEALED and never decrypted on the server: `ports.reseal` is the sealing processes' own transfer (lib/keywrap wraps each field's key to the target Space's
// sealer): `targetKey()`, `export({ from, urn, field, ref }, targetKey)` in this device's sealing process, `import({ blob, to, urn, field })` in the target's. With sealed fields in the plan and no such port, the plan has a blocker.
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

/**
 * Fields the Personal space's type has that My Cloud's type of the same name lacks (My Cloud's core types, a contact for one, may be the narrower definition): added, never removed or changed, so what
 * is already in My Cloud keeps meaning what it meant. @param {any[]} localDefs @param {any[]} remoteDefs @returns {{ type: string, fields: any[] }[]}
 */
function fieldsToAdd(localDefs, remoteDefs) {
  /** @type {{ type: string, fields: any[] }[]} */ const out = [];
  for (const t of localDefs) {
    const r = remoteDefs.find(x => x.name === t.name);
    if (!r) continue;
    const have = new Set((r.fields || []).map((/** @type {any} */ f) => f.name));
    const missing = (t.fields || []).filter((/** @type {any} */ f) => !have.has(f.name));
    if (missing.length) out.push({ type: t.name, fields: missing });
  }
  return out;
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
 * @param {{ local: any, remote?: any, to: string, ports?: { chats?: any, memory?: any }, include?: (t: any) => boolean }} o `remote`, when given, lets the plan say which fields My Cloud's types will gain
 */
export async function planUpgrade({ local, remote, to, ports = {}, include = carried }) {
  const defs = (await local.definitions(local.chain)).filter(include);
  const extend = remote ? fieldsToAdd(defs, await remote.definitions(remote.chain)) : [];
  /** @type {{ name: string, count: number, ids: string[] }[]} */ const types = [];
  /** @type {string[]} */ const blockers = [];
  /** @type {string[]} */ const sealed = [];
  for (const t of orderTypes(defs)) {
    /** @type {string[]} */ const ids = [];
    for await (const r of rowsOf(local, t.name)) { ids.push(`${r.id}@${r.version}`); for (const [k, v] of Object.entries(r.data || {})) if (isSealedValue(v)) sealed.push(`${t.name}/${r.id}: ${k}`); }
    types.push({ name: t.name, count: ids.length, ids: ids.sort() });
  }
  if (sealed.length && !ports.reseal) blockers.push(`${sealed.length} sealed field(s) cannot be carried yet: the sealing process has no transfer to My Cloud`);
  const chats = ports.chats ? await ports.chats.plan() : null;
  const memory = ports.memory ? await ports.memory.plan() : null;
  for (const [what, p] of /** @type {[string, any][]} */ ([["chats", chats], ["memory", memory]])) if (p && Array.isArray(p.blockers)) for (const b of p.blockers) blockers.push(`${what}: ${b}`);
  const counts = { records: Object.fromEntries(types.map(t => [t.name, t.count])), total: types.reduce((n, t) => n + t.count, 0), ...(chats ? { chats: chats.counts ?? null } : {}), ...(memory ? { memory: memory.counts ?? null } : {}) };
  const hash = hashOf({ from: local.space, to, types: types.map(t => ({ name: t.name, ids: t.ids })), extend: extend.map(e => ({ type: e.type, fields: e.fields.map((/** @type {any} */ f) => f.name).sort() })), chats: chats && { counts: chats.counts, items: chats.chats }, memory: memory && { counts: memory.counts } });
  return { from: local.space, to, hash, counts, types: types.map(t => ({ name: t.name, count: t.count, ids: t.ids.map(x => x.split("@")[0]) })), extend: extend.map(e => ({ type: e.type, fields: e.fields.map((/** @type {any} */ f) => f.name) })), sealed, blockers };
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
  let sealedMoved = 0;
  const defs = (await local.definitions(local.chain)).filter(include);
  const have = new Set((await remote.definitions(remote.chain)).map((/** @type {any} */ t) => t.name));
  const remoteDefs = await remote.definitions(remote.chain);
  const add = defs.filter((/** @type {any} */ t) => !have.has(t.name));
  // a type My Cloud already has, with fewer fields: it gains the missing ones (named in the plan the person approved), nothing is removed or changed
  const extend = fieldsToAdd(defs, remoteDefs).map(e => { const r = remoteDefs.find((/** @type {any} */ x) => x.name === e.type); return { ...r, fields: [...(r.fields || []), ...e.fields] }; });
  if (add.length || extend.length) await remote.records.define(remote.chain, { ...(add.length ? { add_types: add } : {}), ...(extend.length ? { change_types: extend } : {}) }, {});
  // pass 1: every record, ids kept, with its link fields left out (a link to a record not copied yet would be refused)
  /** @type {{ type: string, id: string, field: string, ref: any }[]} */ const sealedFields = [];
  /** @type {{ type: string, id: string, links: Record<string, any> }[]} */ const withLinks = [];
  for (const t of orderTypes(defs)) {
    const linkFields = new Set((t.fields || []).filter((/** @type {any} */ f) => f.kind === "link").map((/** @type {any} */ f) => f.name));
    moved[t.name] = 0;
    for await (const r of rowsOf(local, t.name)) {
      const exists = await remote.records.get(remote.chain, t.name, r.id).catch(() => null);
      /** @type {Record<string, any>} */ const data = {};
      /** @type {Record<string, any>} */ const links = {};
      for (const [k, v] of Object.entries(r.data || {})) {
        if (isSealedValue(v)) { sealedFields.push({ type: t.name, id: r.id, field: k, ref: v.ref }); continue; }
        if (linkFields.has(k)) { if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) links[k] = rewrite(v, local.space, remote.space); continue; }
        data[k] = v;
      }
      if (exists) {
        // an id already in My Cloud is only "already carried" if it holds the same content: another record with that id is named, never counted
        const same = Object.entries(data).every(([k, v]) => canonical(exists.data[k]) === canonical(v));
        if (!same) { notMoved.push({ what: `${t.name}/${r.id}`, why: "a different record with this id is already in My Cloud" }); continue; }
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
  // pass 3: the sealed fields, each carried sealed to My Cloud's sealing process: the value is never in the clear here, in the report or on the server
  if (sealedFields.length) {
    if (!ports.reseal) for (const f of sealedFields) notMoved.push({ what: `${f.type}/${f.id}.${f.field}`, why: "no sealed transfer is available" });
    else {
      const targetKey = await ports.reseal.targetKey();
      for (const f of sealedFields) {
        try {
          const blob = await ports.reseal.export({ from: local.space, urn: `vyre://${local.space}/${f.type}/${f.id}`, field: f.field, ref: f.ref }, targetKey);
          const value = await ports.reseal.import({ blob, to: remote.space, urn: `vyre://${remote.space}/${f.type}/${f.id}`, field: f.field });
          const cur = await remote.records.get(remote.chain, f.type, f.id);
          await remote.records.update(remote.chain, f.type, f.id, { [f.field]: value }, cur.version);
          sealedMoved++;
        } catch (e) { notMoved.push({ what: `${f.type}/${f.id}.${f.field}`, why: String(/** @type {Error} */ (e).message).slice(0, 120) }); }
      }
    }
  }
  // verify against the plan: every planned record is in My Cloud now
  // verify against the plan by id, not by count: every planned id is in My Cloud, and each missing one is named
  for (const t of plan.types) {
    const there = new Set();
    for await (const r of rowsOf(remote, t.name)) there.add(r.id);
    const missing = (t.ids || []).filter((/** @type {string} */ id) => !there.has(id));
    if (!t.ids && there.size < t.count) notMoved.push({ what: `${t.name}`, why: `${t.count - there.size} of ${t.count} are not in My Cloud` });
    for (const id of missing) if (!notMoved.some(n => n.what.startsWith(`${t.name}/${id}`))) notMoved.push({ what: `${t.name}/${id}`, why: "not in My Cloud after the copy" });
  }
  /** @type {any} */ const out = { moved: { records: moved, ...(sealedFields.length ? { sealed_fields: sealedMoved } : {}) }, notMoved, recordsComplete: notMoved.length === 0 };
  // an owner's port reports what it could not carry by name (`left` for chats, `failed` for memory): each goes into the report as not carried
  for (const [what, port] of /** @type {[string, any][]} */ ([["chats", ports.chats], ["memory", ports.memory]])) {
    if (!port) continue;
    try {
      const r = await port.move({ to: remote.space });
      out.moved[what] = r;
      for (const f of [...((r && r.left) || []), ...((r && r.failed) || [])]) notMoved.push({ what: `${what}: ${String(f.chat ?? f.name ?? f.what ?? "")}`.trim(), why: String(f.why || "not carried").slice(0, 120) });
    } catch (e) { notMoved.push({ what, why: String(/** @type {Error} */ (e).message).slice(0, 120) }); }
  }
  return out;
}
