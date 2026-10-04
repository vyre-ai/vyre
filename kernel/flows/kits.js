// @ts-check
// Kits: install with the grant card, update with a diff of every widening, remove cleanly (contract 5.3, 6.6 T2).
//
// A Kit is a versioned package of definitions: types (with stages and task templates), templates, Flows, roles, teammates, views and
// optional labelled seed data. Installing one is a grant: the card lists everything it adds and what each part may do, a person approves
// it with presence, and only then does anything change. An update shows a diff in which every widening is named. Removing a Kit takes its
// definitions away and never takes data: a type that still holds records is kept and said so.
//
// Kit text, including instructions, descriptions and templates, is `external` until a person has reviewed it (R6-10), and the card says so.
// Records owns the Kit language and its compiler; this file takes a Kit in its stored form and owns install, update and remove.

import { canonical, flowHash } from "./schema.js";
import { compileFlow } from "./compile.js";
import { ROLE_BUNDLES } from "../contracts/index.js";
import { newId } from "./store.js";
import { taskIdOf } from "./stages.js";
import { canonical as kcanonical, sha256 as ksha } from "../core/canonical.js";

export const KIT_FORMAT = 1;
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * @typedef {{ kind: 'type'|'template'|'flow'|'role'|'teammate'|'view'|'seed', name: string, def: any }} Part
 * @typedef {{ kind: string, id: string, space?: string }} ActorRef
 */

export const KIT_TYPES = Object.freeze([
  { name: "kit-proposal", label: "Kit waiting for a yes", fields: [
    { name: "proposal_id", kind: "text", label: "Id" }, { name: "task", kind: "text", label: "Task" }, { name: "body", kind: "text", label: "Proposal" } ] },
  { name: "kit-install", label: "Installed Kit", fields: [
    { name: "kit_id", kind: "text", label: "Kit" }, { name: "version", kind: "number", label: "Version" }, { name: "hash", kind: "text", label: "Hash" },
    { name: "status", kind: "text", label: "Status" }, { name: "by", kind: "text", label: "Installed by" }, { name: "at", kind: "number", label: "When" }, { name: "body", kind: "text", label: "What it added" } ] },
]);

/** The parts of a Kit in install order: types first, then what refers to them. @param {any} kit @returns {Part[]} */
export function kitParts(kit) {
  const inc = kit.includes || {};
  /** @type {Part[]} */ const out = [];
  for (const t of inc.types || []) out.push({ kind: "type", name: t.name, def: t });
  for (const t of inc.templates || []) out.push({ kind: "template", name: t.name, def: t });
  for (const r of inc.roles || []) out.push({ kind: "role", name: r.name, def: r });
  for (const t of inc.teammates || []) out.push({ kind: "teammate", name: t.name, def: t });
  for (const v of inc.views || []) out.push({ kind: "view", name: v.name, def: v });
  for (const f of inc.flows || []) out.push({ kind: "flow", name: f.name, def: f });
  for (const s of inc.seed || []) out.push({ kind: "seed", name: `${s.type}:${canonical(s.data).length}`, def: s });
  return out;
}

export const kitHash = (/** @type {any} */ kit) => flowHash(kit);
/** What the kernel's approved-Kit waiver is bound to (kernel/tasks/kit-apply.js): the Kit's id, version, content hash and the type definitions it defines, byte for byte. @param {any} kit */
export const waiverKit = kit => ({ id: kit.id, version: kit.version, hash: kitHash(kit), types: kitParts(kit).filter(x => x.kind === "type").map(x => x.def) });
export const waiverHash = (/** @type {any} */ kit) => ksha(kcanonical(waiverKit(kit)));

/** @param {any} kit @param {import('./compile.js').Catalog} cat @returns {{ ok: boolean, errors: { path: string, message: string }[], cat: import('./compile.js').Catalog }} */
export function checkKit(kit, cat) {
  /** @type {{ path: string, message: string }[]} */ const errors = [];
  if (!kit || typeof kit !== "object") return { ok: false, errors: [{ path: "", message: "a Kit is an object" }], cat };
  if (kit.format !== KIT_FORMAT) errors.push({ path: "format", message: `format is ${KIT_FORMAT}` });
  if (typeof kit.id !== "string" || !NAME_RE.test(kit.id)) errors.push({ path: "id", message: "a Kit id is lowercase letters, digits, hyphens and underscores" });
  if (!Number.isInteger(kit.version) || kit.version < 1) errors.push({ path: "version", message: "a version is a whole number from 1" });
  if (typeof kit.name !== "string" || !kit.name) errors.push({ path: "name", message: "a Kit has a name" });
  const parts = kitParts(kit);
  const seen = new Set();
  for (const p of parts) {
    const k = `${p.kind}:${p.name}`;
    if (seen.has(k)) errors.push({ path: `includes.${p.kind}s`, message: `${p.name} is defined twice` });
    seen.add(k);
    if (p.kind !== "seed" && !(typeof p.name === "string" && p.name)) errors.push({ path: `includes.${p.kind}s`, message: `a ${p.kind} needs a name` });
  }
  // The Kit's own types join the catalog, so its Flows may refer to them.
  const types = { ...cat.types };
  for (const p of parts) if (p.kind === "type") types[p.name] = p.def;
  const merged = { ...cat, types, templates: [...(cat.templates || []), ...parts.filter(p => p.kind === "template").map(p => p.name)], roles: [...(cat.roles || []), ...parts.filter(p => p.kind === "role").map(p => p.name)], teammates: [...(cat.teammates || []), ...parts.filter(p => p.kind === "teammate").map(p => p.name)] };
  for (const p of parts) {
    if (p.kind === "flow") {
      const r = compileFlow({ ...p.def, authorship: "kit" }, merged);
      for (const e of r.errors) errors.push({ path: `flow ${p.name}: ${e.path}`, message: e.message });
    }
    if (p.kind === "type") {
      if (!Array.isArray(p.def.fields) || !p.def.fields.length) errors.push({ path: `type ${p.name}`, message: "a type has fields" });
      for (const f of p.def.fields || []) if (f.kind === "sealed" && !f.seal) errors.push({ path: `type ${p.name}.${f.name}`, message: "a sealed field names its class and level" });
    }
    if (p.kind === "role") {
      const b = Object.values(ROLE_BUNDLES).find(x => x.role === p.def.base);
      if (!b) errors.push({ path: `role ${p.name}`, message: "a Kit role is built on one of the five roles (base: owner, admin, manager, member or temp)" });
    }
  }
  return { ok: errors.length === 0, errors, cat: merged };
}

/**
 * What installing this Kit adds, in words and numbers, with everything that could surprise: outward steps, sealed uses, Code steps, web calls, new roles,
 * assistants that start from the Kit's own instructions. This is the body of the install card.
 * @param {any} kit @param {import('./compile.js').Catalog} cat
 */
export function installCard(kit, cat) {
  const checked = checkKit(kit, cat);
  const parts = kitParts(kit);
  const merged = checked.cat;
  const flows = parts.filter(p => p.kind === "flow").map(p => {
    const c = compileFlow({ ...p.def, authorship: "kit" }, merged);
    return { name: p.name, label: p.def.label || p.name, trigger: p.def.trigger.on, writes: c.effects.writes, outward: c.effects.outward, services: c.effects.services, code: c.effects.code, sealed_uses: c.effects.sealed_uses, asks: c.effects.asks, caps: c.caps, ok: c.ok };
  });
  const types = parts.filter(p => p.kind === "type").map(p => ({
    name: p.name, label: p.def.label, fields: (p.def.fields || []).length, sealed: (p.def.fields || []).filter((/** @type {any} */ f) => f.kind === "sealed").map((/** @type {any} */ f) => f.name),
    stages: (p.def.stages || []).map((/** @type {any} */ s) => ({ name: s.name, tasks: (s.tasks || []).map((/** @type {any} */ t) => ({ title: t.title, doer: t.doer, checker: t.checker || null, output: t.output && t.output.kind })) })),
    replaces: Boolean(merged.types[p.name] && merged.types[p.name] !== p.def && cat.types[p.name]),
  }));
  const roles = parts.filter(p => p.kind === "role").map(p => ({ name: p.name, base: p.def.base, abilities: p.def.abilities || [] }));
  const teammates = parts.filter(p => p.kind === "teammate").map(p => ({ name: p.name, instructions_chars: String(p.def.instructions || "").length, trust: "external" }));
  const templates = parts.filter(p => p.kind === "template").map(p => ({ name: p.name, kind: p.def.kind, slots: sealedSlots(p.def.body), trust: "external" }));
  const seed = parts.filter(p => p.kind === "seed").length;
  /** @type {string[]} */ const notes = [];
  if (flows.some(f => f.outward.length)) notes.push("Some Flows send or publish. Each one still asks, or a person approves each run, according to your rules.");
  if (flows.some(f => f.code.length)) notes.push("Some Flows run code in the sandbox.");
  if (flows.some(f => f.sealed_uses.length) || types.some(t => t.sealed.length)) notes.push("Sealed fields are in play: assistants only ever see placeholders.");
  if (teammates.length) notes.push("Assistants start from this Kit's own instructions, which count as outside text until you have read them.");
  return {
    kit: { id: kit.id, version: kit.version, name: kit.name, description: kit.description || "", hash: kitHash(kit) },
    ok: checked.ok, errors: checked.errors,
    adds: { types, templates, roles, teammates, flows, views: parts.filter(p => p.kind === "view").map(p => p.name), seed },
    notes, trust: "external",
  };
}

/** The `{{sealed.x}}` slots a template body declares. @param {any} body */
export function sealedSlots(body) {
  const out = [];
  for (const m of String(body || "").matchAll(/\{\{\s*sealed\.([a-z0-9_.]+)\s*\}\}/gi)) out.push(m[1]);
  return out;
}

/**
 * The difference between an installed Kit and a new version of it. Every widening (a part that can do more than before) is named, so a person
 * approves what changes, not the whole Kit again.
 * @param {any} oldKit @param {any} newKit @param {import('./compile.js').Catalog} cat
 */
export function diffKits(oldKit, newKit, cat) {
  const a = new Map(kitParts(oldKit).map(p => [`${p.kind}:${p.name}`, p]));
  const b = new Map(kitParts(newKit).map(p => [`${p.kind}:${p.name}`, p]));
  /** @type {{ kind: string, name: string }[]} */ const added = [], removed = [], changed = [];
  /** @type {{ part: string, what: string }[]} */ const widenings = [];
  /** @type {{ part: string, what: string }[]} */ const risks = [];
  for (const [k, p] of b) { if (!a.has(k)) added.push({ kind: p.kind, name: p.name }); else if (canonical(a.get(k)?.def) !== canonical(p.def)) changed.push({ kind: p.kind, name: p.name }); }
  for (const [k, p] of a) if (!b.has(k)) removed.push({ kind: p.kind, name: p.name });
  const mergedOld = checkKit(oldKit, cat).cat, mergedNew = checkKit(newKit, cat).cat;
  /** @param {any} p @param {import('./compile.js').Catalog} c */
  const fx = (p, c) => compileFlow({ ...p.def, authorship: "kit" }, c);
  for (const p of b.values()) {
    const before = a.get(`${p.kind}:${p.name}`);
    const label = `${p.kind} ${p.name}`;
    if (p.kind === "flow") {
      const nf = fx(p, mergedNew), of = before ? fx(before, mergedOld) : null;
      const oldCaps = new Set((of ? of.caps : []).map(c => `${c.action} ${c.resource}`));
      for (const c of nf.caps) if (!oldCaps.has(`${c.action} ${c.resource}`)) widenings.push({ part: label, what: `may now ${c.action} on ${c.resource}` });
      const oldOut = new Set((of ? of.effects.outward : []).map(o => o.action + (o.destination_constant ? "" : "*")));
      for (const o of nf.effects.outward) if (!oldOut.has(o.action + (o.destination_constant ? "" : "*"))) widenings.push({ part: label, what: `now ${o.action}${o.destination_constant ? "" : " to an address read from records"}` });
      const svcKey = (/** @type {any} */ h) => `${h.connector} ${h.method} ${h.path}`;
      const oldSvc = new Set((of ? of.effects.services : []).map(svcKey));
      for (const h of nf.effects.services) if (!oldSvc.has(svcKey(h))) widenings.push({ part: label, what: `now calls ${h.connector}: ${h.method} ${h.path}${h.outward ? " (held for a yes)" : ""}` });
      const oldCode = new Set((of ? of.effects.code : []).map(c => c.hash));
      for (const c of nf.effects.code) if (!oldCode.has(c.hash)) widenings.push({ part: label, what: `runs new code in the sandbox (${c.step})` });
      const oldSealed = new Set((of ? of.effects.sealed_uses : []).map(s => s.field));
      for (const s of nf.effects.sealed_uses) if (!oldSealed.has(s.field)) widenings.push({ part: label, what: `now uses the sealed field ${s.field}` });
      if (before && before.def.trigger && canonical(before.def.trigger) !== canonical(p.def.trigger)) widenings.push({ part: label, what: "starts on a different trigger" });
    }
    if (p.kind === "role" && before) {
      const old = new Set(before.def.abilities || []);
      for (const ab of p.def.abilities || []) if (!old.has(ab)) widenings.push({ part: label, what: `now holds ${ab}` });
    }
    if (p.kind === "role" && !before) widenings.push({ part: label, what: `a new role holding ${(p.def.abilities || []).length} abilities` });
    if (p.kind === "teammate" && (!before || before.def.instructions !== p.def.instructions)) widenings.push({ part: label, what: "its starting instructions changed (outside text until read)" });
    if (p.kind === "template") {
      const oldSlots = new Set(sealedSlots(before && before.def.body));
      for (const s of sealedSlots(p.def.body)) if (!oldSlots.has(s)) widenings.push({ part: label, what: `now merges the sealed field ${s}` });
    }
    if (p.kind === "type") {
      const oldF = new Map(((before && before.def.fields) || []).map((/** @type {any} */ f) => [f.name, f]));
      for (const f of p.def.fields || []) {
        if (!oldF.has(f.name) && f.kind === "sealed") widenings.push({ part: label, what: `a new sealed field ${f.name}` });
        const o = /** @type {any} */ (oldF.get(f.name));
        if (o && o.kind !== f.kind) risks.push({ part: label, what: `${f.name} changes kind from ${o.kind} to ${f.kind}` });
      }
      const newF = new Set((p.def.fields || []).map((/** @type {any} */ f) => f.name));
      for (const name of oldF.keys()) if (!newF.has(name)) risks.push({ part: label, what: `the field ${name} is removed (its values stay in the store)` });
      const oldTasks = new Map(((before && before.def.stages) || []).flatMap((/** @type {any} */ s) => (s.tasks || []).map((/** @type {any} */ t) => [`${s.name}/${t.title}`, t])));
      for (const s of p.def.stages || []) for (const t of s.tasks || []) {
        const o = /** @type {any} */ (oldTasks.get(`${s.name}/${t.title}`));
        if (!o) widenings.push({ part: label, what: `a new task "${t.title}" in ${s.name}` });
        else if (o.doer !== t.doer || (o.checker || null) !== (t.checker || null)) widenings.push({ part: label, what: `"${t.title}" changes doer or checker` });
        else if (o.output && t.output && (o.output.kind !== t.output.kind)) widenings.push({ part: label, what: `"${t.title}" now ends in ${t.output.kind}` });
      }
    }
  }
  for (const r of removed) risks.push({ part: `${r.kind} ${r.name}`, what: "is removed" });
  return { from: oldKit.version, to: newKit.version, added, removed, changed, widenings, risks, widening: widenings.length > 0 };
}

/** The in-memory ledger of installed Kits. */
export class MemoryKitStore {
  constructor() { /** @type {Map<string, any>} */ this.rows = new Map(); /** @type {Map<string, any>} */ this.proposals = new Map(); }
  /** @param {string} id */ async get(id) { const r = this.rows.get(id); return r ? structuredClone(r) : null; }
  /** @param {any} row */ async put(row) { this.rows.set(row.kit_id, structuredClone(row)); }
  /** @param {string} id */ async del(id) { this.rows.delete(id); }
  async list() { return [...this.rows.values()].map(r => structuredClone(r)); }
  /** @param {any} p */ async putProposal(p) { this.proposals.set(p.id, structuredClone(p)); }
  /** @param {string} id */ async getProposal(id) { const p = this.proposals.get(id); return p ? structuredClone(p) : null; }
  /** @param {string} id */ async delProposal(id) { this.proposals.delete(id); }
  /** @param {string} task */ async proposalByTask(task) { return [...this.proposals.values()].map(p => structuredClone(p)).find(p => p.task === task) || null; }
}

/** The installed Kits and the proposals waiting for a yes, as records in the kernel: they survive a restart, with version history and the audit log. @implements the MemoryKitStore methods */
export class RecordsKitStore {
  /** @param {{ kernel: any, chain: any }} o */
  constructor(o) { this.k = o.kernel; this.chain = o.chain; }
  async define() { return this.k.records.define(this.chain, { add_types: KIT_TYPES }); }
  /** @param {string} type @param {string} field @param {string} value */
  async #one(type, field, value) { return (await this.k.records.query(this.chain, type, { filter: { field, op: "eq", value }, page: { limit: 1 } })).rows[0] || null; }
  /** @param {string} id */ async get(id) { const r = await this.#one("kit-install", "kit_id", id); return r ? JSON.parse(r.data.body) : null; }
  /** @param {any} row */ async put(row) {
    const data = { kit_id: row.kit_id, version: row.version ?? 0, hash: row.hash || "", status: row.status || "", by: row.by ? `${row.by.kind}:${row.by.id}` : "", at: row.at || 0, body: JSON.stringify(row) };
    const cur = await this.#one("kit-install", "kit_id", row.kit_id);
    if (cur) await this.k.records.update(this.chain, "kit-install", cur.id, data, cur.version); else await this.k.records.create(this.chain, "kit-install", data);
  }
  /** @param {string} id */ async del(id) { const cur = await this.#one("kit-install", "kit_id", id); if (cur) await this.k.records.remove(this.chain, "kit-install", cur.id, cur.version); }
  async list() { return (await this.k.records.query(this.chain, "kit-install", { page: { limit: 200 } })).rows.map((/** @type {any} */ r) => JSON.parse(r.data.body)); }
  /** @param {any} p */ async putProposal(p) { await this.k.records.create(this.chain, "kit-proposal", { proposal_id: p.id, task: p.task || "", body: JSON.stringify(p) }); }
  /** @param {string} id */ async getProposal(id) { const r = await this.#one("kit-proposal", "proposal_id", id); return r ? JSON.parse(r.data.body) : null; }
  /** @param {string} id */ async delProposal(id) { const r = await this.#one("kit-proposal", "proposal_id", id); if (r) await this.k.records.remove(this.chain, "kit-proposal", r.id, r.version); }
  /** @param {string} task */ async proposalByTask(task) { const r = await this.#one("kit-proposal", "task", task); return r ? JSON.parse(r.data.body) : null; }
}

/**
 * @typedef {{
 *   kernel: any, runner: any, store: any,
 *   catalog: () => Promise<import('./compile.js').Catalog> | import('./compile.js').Catalog,
 *   chains: { forFlow: (o: any) => any },
 *   clock?: () => number,
 *   installerRole?: (approver: ActorRef) => Promise<string> | string,
 *   ports?: { teammates?: { create: (chain: any, t: any) => Promise<any>, remove: (chain: any, name: string) => Promise<any> },
 *             define?: (chain: any, types: any[]) => Promise<any> },
 * }} KitOptions
 */

export class KitManager {
  /** @param {KitOptions} o */
  constructor(o) { this.k = o.kernel; this.runner = o.runner; this.store = o.store; this.catalogFn = o.catalog; this.chains = o.chains; this.now = o.clock || (() => Date.now()); this.roleOf = o.installerRole; this.ports = o.ports || {}; }

  /** The chain a Kit's work runs under: the Kit as an automation, narrowed by the approver. @param {any} cat @param {string} kitId @param {ActorRef} approver */
  #chain(cat, kitId, approver) { return this.chains.forFlow({ flow: `kit:${kitId}`, space: cat.space, approver, tainted: false, run: `kit_${kitId}`, source_spaces: [cat.space] }); }

  /**
   * Ask to install (or update) a Kit. Nothing changes: this makes the card and a `kit_install` task for the approver. A Kit that does not compile,
   * or whose roles would exceed the installer's own, is refused here with reasons.
   * @param {any} kit @param {ActorRef} approver @param {any} callerChain the person's own chain
   */
  async propose(kit, approver, callerChain) {
    const cat = await this.catalogFn();
    // Asking is `kits.propose` (a write: an assistant narrowed from the person may ask); the install itself is `kits.install` (admin), checked below when the approved task is applied.
    const d = await this.k.authorize({ chain: callerChain, action: "kits.propose", resource: `vyre://${cat.space}/kit/${kit.id}` });
    if (d.effect === "deny") throw Object.assign(new Error("you may not ask for Kits here"), { code: d.reason === "no_grant" ? "not_found" : d.reason });
    const installed = await this.store.get(kit.id);
    const card = installCard(kit, cat);
    if (!card.ok) return { ok: false, errors: card.errors, card };
    if (installed && installed.version >= kit.version) return { ok: false, errors: [{ path: "version", message: `version ${installed.version} is already installed` }], card };
    if (this.roleOf) {
      const mine = await this.roleOf(approver);
      const mineAbilities = new Set(/** @type {any} */ (ROLE_BUNDLES)[mine] ? /** @type {any} */ (ROLE_BUNDLES)[mine].abilities : []);
      for (const r of kitParts(kit).filter(p => p.kind === "role")) for (const ab of r.def.abilities || []) if (!mineAbilities.has(ab)) return { ok: false, errors: [{ path: `role ${r.name}`, message: `the role would hold ${ab}, which the person installing does not hold` }], card };
    }
    const diff = installed ? diffKits(installed.kit, kit, cat) : null;
    const id = newId("kp_");
    // The install card is a task the Flows service asks and the approver CHECKS: their approve or reject (with presence) is the answer, as for any approval.
    const doerChain = this.chains.forDoer ? this.chains.forDoer({ kit: kit.id, space: cat.space, approver }) : null;
    const task = await this.k.ask.request(this.#chain(cat, kit.id, approver), {
      title: installed ? `Update ${kit.name} to version ${kit.version}?` : `Install ${kit.name}?`, output: { kind: "decision" }, source: "manual",
      ...(doerChain ? { doer: { kind: "service", id: "flows", space: cat.space }, checker: approver } : { doer: approver }),
      form: { kind: "kit_install", proposal: id, kit_hash: waiverHash(kit), card, diff },
    }, { idem: `kit:${kit.id}:${kit.version}:${kitHash(kit)}` });
    if (doerChain) for (const [step, arg] of [["start"], ["complete", { answer: "yes", reason: `${kit.name} version ${kit.version} is waiting for your yes` }]]) {
      try { await (step === "start" ? this.k.ask.start(doerChain, task.id) : this.k.ask.complete(doerChain, task.id, arg)); } catch (e) { if (!e || !["bad_state", "not_allowed"].includes(/** @type {any} */ (e).code)) throw e; }
    }
    await this.store.putProposal({ id, kit, hash: kitHash(kit), approver, task: task.id, at: this.now(), update: Boolean(installed) });
    return { ok: true, proposal: id, task: task.id, card, diff };
  }

  /** A task event from the kernel: if it is an approved Kit task, apply it. @param {any} env */
  async onEvent(env) {
    if (!/^task\./.test(env.type)) return null;
    // The kernel's own task events carry only the subject: the task id is its last segment, and the outcome is read from the task, not from the event.
    const id = taskIdOf(env);
    if (!id) return null;
    const p = await this.store.proposalByTask(id);
    if (!p) return null;
    const cat = await this.catalogFn();
    const row = await this.k.ask.get(this.#chain(cat, p.kit.id, p.approver), id);
    if (!row || row.state !== "done") return null;
    if (row.outcome !== "approved") { await this.store.delProposal(p.id); return { declined: p.kit.id }; }
    return this.apply(p.id);
  }

  /** Apply an approved proposal. Idempotent per step: a crash mid-way resumes from the ledger. @param {string} proposalId */
  async apply(proposalId) {
    const p = await this.store.getProposal(proposalId);
    if (!p) throw Object.assign(new Error("no such proposal"), { code: "not_found" });
    const cat = await this.catalogFn();
    const kit = p.kit;
    if (kitHash(kit) !== p.hash) throw Object.assign(new Error("the Kit changed after it was approved"), { code: "hash_mismatch" });
    const chain = this.#chain(cat, kit.id, p.approver);
    // The install is the approver's act: the kernel decides `kits.install` for their chain before anything changes (a person who is no longer an admin installs nothing). The ledger row below, a
    // record write the kernel logs, comes before any definition, so an install that stops half way is on the record and resumes from it.
    const may = await this.k.authorize({ chain, action: "kits.install", resource: `vyre://${cat.space}/kit/${kit.id}` });
    if (may.effect === "deny") throw Object.assign(new Error("the approver may not install Kits here"), { code: may.reason === "no_grant" ? "not_found" : may.reason });
    const prior = await this.store.get(kit.id);
    const parts = kitParts(kit);
    const row = prior && prior.status === "installing" ? prior : { kit_id: kit.id, version: kit.version, hash: p.hash, status: "installing", by: p.approver, at: this.now(), kit, from: prior ? prior.kit : null, added: /** @type {any[]} */ ([]), flows: /** @type {Record<string, string>} */ ({}), refs: /** @type {Record<string, any>} */ ({}) };
    if (prior && prior.status === "installed") { row.from = prior.kit; row.flows = { ...prior.flows }; row.refs = { ...(prior.refs || {}) }; row.added = [...(prior.added || [])]; row.status = "installing"; }
    await this.store.put(row);

    // types first, as one definition change
    const types = parts.filter(x => x.kind === "type").map(x => x.def);
    if (types.length) {
      const old = prior ? new Set(kitParts(prior.kit).filter(x => x.kind === "type").map(x => x.name)) : new Set();
      const add = types.filter(t => !old.has(t.name) && !cat.types[t.name]);
      const change = types.filter(t => old.has(t.name) || cat.types[t.name]);
      // The kernel's approved-Kit waiver (kernel/tasks/kit-apply.js): the owner's approval of THIS task, which signed the form's kit_hash, stands for the admin presence the type definitions ask
      // for, once. A resumed install whose types are already defined (the ledger says so) asks for nothing, so a spent approval never blocks the rest.
      const need = types.some(t => !row.added.includes(`type:${t.name}`));
      const waiver = need && this.k.kits && p.task ? await this.k.kits.begin({ chain, task: p.task, kit: waiverKit(kit) }) : undefined;
      if (need) await this.k.records.define(chain, { ...(add.length ? { add_types: add } : {}), ...(change.length ? { change_types: change } : {}) }, waiver ? { waiver } : undefined);
      if (waiver && this.k.kits) await this.k.kits.end(waiver);
      for (const t of types) if (!row.added.includes(`type:${t.name}`)) row.added.push(`type:${t.name}`);
    }
    for (const part of parts) {
      const key = `${part.kind}:${part.name}`;
      if (part.kind === "type" || part.kind === "seed") continue;
      if (part.kind === "template") {
        const existing = row.refs[key];
        const data = { name: part.name, kind: part.def.kind, ...(part.def.subject ? { subject: part.def.subject } : {}), body: part.def.body, kit: kit.id };
        if (existing) { const cur = await this.k.records.get(chain, "template", existing); if (cur) await this.k.records.update(chain, "template", existing, data, cur.version); }
        else { const r = await this.k.records.create(chain, "template", data, { idem: `kit:${kit.id}:${key}` }); row.refs[key] = r.id; }
      } else if (part.kind === "flow") {
        const d = await this.runner.define(row.flows[part.name] || null, { ...part.def, authorship: "kit" }, p.approver);
        if (!d.ok) throw Object.assign(new Error(`Flow ${part.name} did not compile: ${d.errors[0].message}`), { code: "invalid" });
        row.flows[part.name] = d.id;
        // the person approved this Kit's content, and the card showed this Flow; that approval covers the version just stored
        await this.runner.approve(d.id, d.version, p.approver, d.hash);
      } else if (part.kind === "role" || part.kind === "view") {
        const type = part.kind === "role" ? "def-role" : "def-view";
        await this.#ensureDefType(chain, type);
        const data = { name: part.name, body: canonical(part.def), kit: kit.id };
        const existing = row.refs[key];
        if (existing) { const cur = await this.k.records.get(chain, type, existing); if (cur) await this.k.records.update(chain, type, existing, data, cur.version); }
        else { const r = await this.k.records.create(chain, type, data, { idem: `kit:${kit.id}:${key}` }); row.refs[key] = r.id; }
      } else if (part.kind === "teammate") {
        if (this.ports.teammates) await this.ports.teammates.create(chain, { name: part.name, instructions: part.def.instructions, kit: kit.id, trust: "external" });
      }
      if (!row.added.includes(key)) row.added.push(key);
      await this.store.put(row);
    }
    // a removed part of an update goes away: its Flow is switched off, its definition records are deleted
    if (row.from) {
      const keep = new Set(parts.map(x => `${x.kind}:${x.name}`));
      for (const gone of kitParts(row.from).filter(x => !keep.has(`${x.kind}:${x.name}`))) await this.#drop(chain, row, gone);
    }
    row.status = "installed"; row.from = null; row.at = this.now();
    await this.store.put(row);
    await this.store.delProposal(proposalId);
    return { installed: kit.id, version: kit.version, flows: row.flows };
  }

  /** The types a Kit's roles and views are stored as, made once when the first one is installed (the kernel's type names are lowercase with hyphens). @param {any} chain @param {string} type */
  async #ensureDefType(chain, type) {
    if ((await this.catalogFn()).types[type]) return;
    try { await this.k.records.define(chain, { add_types: [{ name: type, label: type === "def-role" ? "Role definition" : "View definition", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "body", kind: "text", label: "Definition" }, { name: "kit", kind: "text", label: "From Kit" }] }] }); }
    catch (e) { if (!e || !["already_exists", "conflict", "bad_input"].includes(/** @type {any} */ (e).code)) throw e; }
  }

  /** @param {any} chain @param {any} row @param {Part} part */
  async #drop(chain, row, part) {
    const key = `${part.kind}:${part.name}`;
    if (part.kind === "flow") { const id = row.flows[part.name]; if (id) { await this.runner.store.disable(id); this.runner.cache = null; delete row.flows[part.name]; } }
    else if (["template", "role", "view"].includes(part.kind)) {
      const type = part.kind === "template" ? "template" : part.kind === "role" ? "def-role" : "def-view";
      const ref = row.refs[key];
      if (ref) { const cur = await this.k.records.get(chain, type, ref); if (cur && !cur.deleted_at) await this.k.records.remove(chain, type, ref, cur.version); delete row.refs[key]; }
    } else if (part.kind === "teammate" && this.ports.teammates) await this.ports.teammates.remove(chain, part.name);
    row.added = row.added.filter((/** @type {string} */ x) => x !== key);
  }

  /**
   * Remove a Kit: its Flows stop, its templates, roles and views are deleted, its assistants are removed, and its types are removed only when they hold
   * no records (otherwise they stay and the answer says which). Data is never deleted. Needs the person's yes: this is `kits.remove`.
   * @param {string} kitId @param {ActorRef} approver @param {any} callerChain
   */
  async remove(kitId, approver, callerChain) {
    const cat = await this.catalogFn();
    const row = await this.store.get(kitId);
    if (!row || row.status === "removed") throw Object.assign(new Error("that Kit is not installed"), { code: "not_found" });
    const d = await this.k.authorize({ chain: callerChain, action: "kits.remove", resource: `vyre://${cat.space}/kit/${kitId}` });
    if (d.effect !== "allow") throw Object.assign(new Error(d.effect === "ask" ? "removing a Kit needs a person's yes first" : "you may not remove Kits here"), { code: d.effect === "ask" ? "needs_approval" : d.reason });
    const chain = this.#chain(cat, kitId, approver);
    const parts = kitParts(row.kit);
    for (const part of parts.filter(p => p.kind !== "type" && p.kind !== "seed")) await this.#drop(chain, row, part);
    /** @type {string[]} */ const removedTypes = [], keptTypes = [];
    for (const part of parts.filter(p => p.kind === "type")) {
      const any = await this.k.records.query(chain, part.name, { page: { limit: 1 } });
      if (any.rows.length) keptTypes.push(part.name);
      else { await this.k.records.define(chain, { remove_types: [part.name] }); removedTypes.push(part.name); }
    }
    for (const g of await this.k.grants.list(chain, {}).catch(() => [])) if (g.source === `install:${kitId}` && g.status === "active") await this.k.grants.revoke(chain, g.id, `Kit ${kitId} removed`);
    row.status = "removed"; row.removed_at = this.now();
    await this.store.put(row);
    return { removed: kitId, flows_stopped: Object.keys(row.flows || {}).length, types_removed: removedTypes, types_kept: keptTypes, note: keptTypes.length ? `Kept ${keptTypes.join(", ")}: they still hold records.` : "" };
  }

  async list() { return (await this.store.list()).map((/** @type {any} */ r) => ({ id: r.kit_id, version: r.version, status: r.status, by: r.by, at: r.at })); }
}
