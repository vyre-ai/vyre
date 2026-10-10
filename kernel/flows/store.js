// @ts-check
// Where Flow definitions, approvals and runs are kept. The runner talks to one small interface; two implementations satisfy it:
//   MemoryFlowStore   for tests and for simulation (nothing persists)
//   RecordsFlowStore  over the kernel's record calls: definitions are records of the reserved kind `def-flow`, runs are records of
//                     `flow-run`, so they inherit version history, grants, undo and audit like any record (contract 5.1, 9.2).
//
// A definition is immutable once stored: a change is a new version. An approval binds (flow, version, hash) to the person who gave it.
// Only an approved version can be active, and a version is active only while its approval stands.

import crypto from "node:crypto";
import { flowHash, canonical } from "./schema.js";
import { newPrefixedId } from "../../lib/id.js";

/**
 * @typedef {{ kind: string, id: string, space?: string }} ActorRef
 * @typedef {{ flow: string, version: number, hash: string, approver: ActorRef, at: number, note?: string }} Approval
 * @typedef {{ id: string, name: string, space: string, versions: { version: number, hash: string, flow: any, authorship: string, at: number, by: ActorRef }[], approvals: Approval[], active: number|null, status: 'active'|'paused'|'disabled', paused?: { reason: string, since: number } }} FlowRow
 * @typedef {{
 *   id: string, flow: string, version: number, hash: string, space: string,
 *   trigger: { kind: string, key: string, source?: string, event?: any, input?: any, path?: string, at?: number, caught_up?: boolean, missed?: number, tz?: string },
 *   tainted: boolean, source_spaces: string[], depth: number,
 *   state: 'running'|'waiting'|'paused'|'queued'|'done'|'failed'|'cancelled',
 *   started_at: number, updated_at: number, finished_at?: number,
 *   steps: Record<string, { status: 'started'|'waiting'|'done'|'skipped'|'failed'|'failed_handled', output?: any, error?: { code: string, message: string }, at: number, wait?: any, task?: string, tries?: number, last_error?: any, attempts_log?: { at: number, code: string }[], handling?: boolean, started_at?: number, finished_at?: number, verify?: { ok: boolean, say?: string }, skipped_by?: string|null, skipped_at?: number, substitute?: boolean, [k: string]: any }>,
 *   queued?: { reason: 'concurrency'|'box_limit'|'lock'|'paused'|'draining'|'flow_paused', since: number, seq?: number }, lock_key?: string,
 *   attention?: { kind: 'failed'|'stuck'|'stale'|'verify'|'paused'|'device', step?: string, code?: string, message: string, since: number },
 *   failing?: { step: string, code: string, message: string }, failing_done?: boolean, failing_error?: { code: string, message: string }, cancelled?: { by: string|null, at: number, reason?: string },
 *   gate?: { key: string, urn: string, type: string, record: string, stage: string, next: string | null, owner: string | null, tasks: { id: string, title: string, required: boolean }[] },  a stage gate (s1): a run with no stored Flow
 *   waiting?: { step: string, kind: 'task'|'time'|'event'|'gate'|'children', task?: string, wake_at?: number, event?: string, where?: string, deadline?: number },
 *   error?: { step: string, code: string, message: string },
 *   approver: ActorRef, dry?: boolean,
 *   parent?: { run: string, step: string, lane?: string }, branch?: { step: string, id: string }, inherit?: { trigger: any, event: any, steps: Record<string, any>, locals: Record<string, any> }, result?: any,
 *   record?: string, label?: string,    the record the trigger names (flow-runs contract), and the Flow's words for the timeline
 * }} Run
 */

/** A new random id with a prefix: `fl_`, `run_`. @param {string} prefix */
export const newId = prefix => newPrefixedId(prefix.replace(/_$/, ""));

/** The deterministic id of a run: the same (flow, trigger key) is the same run, however many times the trigger is delivered. @param {string} flow @param {string} key */
export const runIdFor = (flow, key) => "run_" + crypto.createHash("sha256").update(flow + "\n" + key).digest("base64url").slice(0, 22).toLowerCase().replace(/[^a-z0-9]/g, "x");

export class MemoryFlowStore {
  constructor() {
    /** @type {Map<string, FlowRow>} */ this.flows = new Map();
    /** @type {Map<string, Run>} */ this.runs = new Map();
    /** @type {Map<string, number>} flow id -> when its schedule last ran (so a restart catches up once instead of forgetting) */ this.schedules = new Map();
    /** @type {any} */ this.control = null;
    /** @type {Map<string, any[]>} saved test cases by flow id */ this.tests = new Map();
  }

  /** @param {string} flow */
  async getTests(flow) { return structuredClone(this.tests.get(flow) || []); }
  /** @param {string} flow @param {any[]} cases */
  async putTests(flow, cases) { this.tests.set(flow, structuredClone(cases)); }

  /** @param {string} flow @returns {Promise<number|null>} */
  async getSchedule(flow) { return this.schedules.has(flow) ? /** @type {number} */ (this.schedules.get(flow)) : null; }
  /** @param {string} flow @param {number} lastFire */
  async putSchedule(flow, lastFire) { this.schedules.set(flow, lastFire); }

  /** Store a new version of a Flow (creating the Flow on its first). Returns the version and hash. @param {string|null} id @param {any} flow @param {ActorRef} by @param {number} at @param {string} space */
  async putVersion(id, flow, by, at, space) {
    let row = id ? this.flows.get(id) : undefined;
    if (!row) {
      row = { id: id || newId("fl_"), name: flow.name, space, versions: [], approvals: [], active: null, status: "active" };
      this.flows.set(row.id, row);
    }
    const hash = flowHash(flow);
    const last = row.versions[row.versions.length - 1];
    if (last && last.hash === hash) return { id: row.id, version: last.version, hash, same: true };
    const version = (last ? last.version : 0) + 1;
    row.versions.push({ version, hash, flow: structuredClone(flow), authorship: flow.authorship, at, by });
    return { id: row.id, version, hash, same: false };
  }

  /** @param {string} id @param {number} version @param {ActorRef} approver @param {string} hash @param {number} at */
  /** Every stored version of every Flow, drafts too, as { id, version, flow } (for the Vault's scan and Used by). */
  async allVersions() { return [...this.flows.values()].flatMap(r => r.versions.map(v => ({ id: r.id, version: v.version, flow: structuredClone(v.flow) }))); }
  async approve(id, version, approver, hash, at) {
    const row = this.flows.get(id);
    const v = row && row.versions.find(x => x.version === version);
    if (!row || !v) throw Object.assign(new Error("no such Flow version"), { code: "not_found" });
    if (v.hash !== hash) throw Object.assign(new Error("the approval is for different content than this version"), { code: "hash_mismatch" });
    row.approvals.push({ flow: id, version, hash, approver, at });
    row.active = version;
    row.status = "active"; delete row.paused;
    return row.approvals[row.approvals.length - 1];
  }

  /** The active version's Flow, its approver and hash; null when none, paused or disabled. @param {string} id */
  async active(id) {
    const row = this.flows.get(id);
    if (!row || row.active === null || row.status !== "active") return null;
    return this.#view(row, row.active);
  }

  /** A specific version, whatever its state. @param {string} id @param {number} version */
  async getVersion(id, version) {
    const row = this.flows.get(id);
    return row ? this.#view(row, version) : null;
  }

  /** @param {FlowRow} row @param {number} version */
  #view(row, version) {
    const v = row.versions.find(x => x.version === version);
    if (!v) return null;
    const approval = [...row.approvals].reverse().find(a => a.version === version && a.hash === v.hash) || null;
    return { id: row.id, space: row.space, version, hash: v.hash, flow: structuredClone(v.flow), approver: approval ? approval.approver : null, approved_at: approval ? approval.at : null, status: row.status };
  }

  /** Every Flow that has an active version, for trigger matching. */
  async activeFlows() {
    const out = [];
    for (const row of this.flows.values()) if (row.status === "active" && row.active !== null) { const v = this.#view(row, row.active); if (v && v.approver) out.push(v); }
    return out;
  }

  /** @param {string} id @param {string} reason @param {number} at */
  async pause(id, reason, at) { const r = this.flows.get(id); if (r) { r.status = "paused"; r.paused = { reason, since: at }; } }
  /** Flows with an approved version that are paused: a trigger that arrives for one is held, not lost. */
  async pausedFlows() {
    const out = [];
    for (const row of this.flows.values()) if (row.status === "paused" && row.active !== null) { const v = this.#view(row, row.active); if (v && v.approver) out.push({ ...v, paused: true }); }
    return out;
  }
  /** The Space-wide switch (pause all, drain): null when nothing was ever set. @returns {Promise<any>} */
  async getControl() { return this.control ? structuredClone(this.control) : null; }
  /** @param {any} c */
  async putControl(c) { this.control = structuredClone(c); }
  /** @param {string} id */
  async resume(id) { const r = this.flows.get(id); if (r) { r.status = "active"; delete r.paused; } }
  /** @param {string} id */
  async disable(id) { const r = this.flows.get(id); if (r) { r.status = "disabled"; r.active = null; } }
  /** @param {string} id */
  async flowRow(id) { const r = this.flows.get(id); return r ? structuredClone(r) : null; }
  async list() { return [...this.flows.values()].map(r => ({ id: r.id, name: r.name, status: r.status, active: r.active, versions: r.versions.length, paused: r.paused || null })); }

  /** @param {Run} run */
  async putRun(run) { this.runs.set(run.id, structuredClone(run)); }
  /** @param {string} id @returns {Promise<Run|null>} */
  async getRun(id) { const r = this.runs.get(id); return r ? structuredClone(r) : null; }
  /** @param {{ flow?: string, state?: string, before?: number, limit?: number }} [f] @returns {Promise<Run[]>} */
  async listRuns(f = {}) {
    let rows = [...this.runs.values()];
    if (f.flow) rows = rows.filter(r => r.flow === f.flow);
    if (f.state) rows = rows.filter(r => r.state === f.state);
    if (f.before !== undefined) rows = rows.filter(r => r.started_at < /** @type {number} */ (f.before));
    rows.sort((a, b) => b.started_at - a.started_at);
    return structuredClone(rows.slice(0, f.limit || 200));
  }
}

/**
 * The same interface over the kernel's record calls. Definitions and runs are records, so the gateway authorizes, versions and audits them.
 * Types (declared by `FLOW_TYPES`) are defined once with `records.define`. The chain is the Flow system's own service chain.
 */
export const FLOW_TYPES = Object.freeze([
  { name: "def-flow", label: "Flow", icon: "flow", fields: [
    { name: "flow_id", kind: "text", label: "Id" }, { name: "name", kind: "text", label: "Name" }, { name: "space", kind: "text", label: "Space" },
    { name: "version", kind: "number", label: "Version" }, { name: "hash", kind: "text", label: "Hash" }, { name: "body", kind: "text", label: "Definition" },
    { name: "authorship", kind: "text", label: "Authorship" }, { name: "by", kind: "text", label: "Made by" } ] },
  { name: "flow-approval", label: "Flow approval", fields: [
    { name: "flow_id", kind: "text", label: "Flow" }, { name: "version", kind: "number", label: "Version" }, { name: "hash", kind: "text", label: "Hash" },
    { name: "approver", kind: "text", label: "Approver" }, { name: "at", kind: "number", label: "When" } ] },
  { name: "flow-state", label: "Flow state", fields: [
    { name: "flow_id", kind: "text", label: "Flow" }, { name: "status", kind: "text", label: "Status" }, { name: "active", kind: "number", label: "Active version" },
    { name: "reason", kind: "text", label: "Reason" }, { name: "since", kind: "number", label: "Since" } ] },
  { name: "flow-control", label: "Flow control", fields: [
    { name: "key", kind: "text", label: "Key" }, { name: "mode", kind: "text", label: "Mode" }, { name: "since", kind: "number", label: "Since" }, { name: "body", kind: "text", label: "Control" } ] },
  { name: "flow-tests", label: "Flow test cases", fields: [
    { name: "flow_id", kind: "text", label: "Flow" }, { name: "body", kind: "text", label: "Cases" } ] },
  { name: "flow-schedule", label: "Flow schedule", fields: [
    { name: "flow_id", kind: "text", label: "Flow" }, { name: "last_fire", kind: "number", label: "Last ran" } ] },
  { name: "flow-run", label: "Flow run", icon: "run", fields: [
    { name: "run_id", kind: "text", label: "Id" }, { name: "flow_id", kind: "text", label: "Flow" }, { name: "state", kind: "text", label: "State" },
    { name: "started_at", kind: "number", label: "Started" }, { name: "body", kind: "text", label: "Run" },
    { name: "title", kind: "text", label: "Flow" }, { name: "record", kind: "link", label: "About" } ] },
]);

export class RecordsFlowStore {
  /** @param {{ kernel: any, chain: any, space: string }} o */
  constructor(o) { this.k = o.kernel; this.chain = o.chain; this.space = o.space; /** @type {Map<string, string>} */ this.ids = new Map(); }

  async define() { return this.k.records.define(this.chain, { add_types: FLOW_TYPES }); }

  /** @param {string} type @param {string} field @param {string} value */
  async #find(type, field, value) {
    const r = await this.k.records.query(this.chain, type, { filter: { field, op: "eq", value }, page: { limit: 200 } });
    return r.rows;
  }

  /** @param {string|null} id @param {any} flow @param {ActorRef} by @param {number} at @param {string} space */
  async putVersion(id, flow, by, at, space) {
    const flowId = id || newId("fl_");
    const hash = flowHash(flow);
    const rows = await this.#find("def-flow", "flow_id", flowId);
    const same = rows.find((/** @type {any} */ r) => r.data.hash === hash);
    if (same) return { id: flowId, version: Number(same.data.version), hash, same: true };
    const version = rows.reduce((/** @type {number} */ m, /** @type {any} */ r) => Math.max(m, Number(r.data.version)), 0) + 1;
    await this.k.records.create(this.chain, "def-flow", { flow_id: flowId, name: flow.name, space, version, hash, body: canonical(flow), authorship: flow.authorship, by: `${by.kind}:${by.id}` });
    return { id: flowId, version, hash, same: false };
  }

  /** @param {string} id @param {number} version @param {ActorRef} approver @param {string} hash @param {number} at */
  /** Every stored version of every Flow, drafts too, as { id, version, flow }. */
  async allVersions() {
    const r = await this.k.records.query(this.chain, "def-flow", { page: { limit: 5000 } });
    return r.rows.map((/** @type {any} */ x) => ({ id: String(x.data.flow_id), version: Number(x.data.version), flow: JSON.parse(x.data.body) }));
  }
  async approve(id, version, approver, hash, at) {
    const v = (await this.#find("def-flow", "flow_id", id)).find((/** @type {any} */ r) => Number(r.data.version) === version);
    if (!v) throw Object.assign(new Error("no such Flow version"), { code: "not_found" });
    if (v.data.hash !== hash) throw Object.assign(new Error("the approval is for different content than this version"), { code: "hash_mismatch" });
    await this.k.records.create(this.chain, "flow-approval", { flow_id: id, version, hash, approver: `${approver.kind}:${approver.id}`, at });
    await this.#setState(id, { status: "active", active: version, reason: "", since: at });
    return { flow: id, version, hash, approver, at };
  }

  /** A Flow that was never defined has no state to change: pausing or resuming it stores nothing. @param {string} id */
  async #known(id) { if (!(await this.#find("def-flow", "flow_id", id)).length) throw Object.assign(new Error("no such Flow"), { code: "not_found" }); }

  /** @param {string} id @param {{ status: string, active?: number|null, reason?: string, since?: number }} s */
  async #setState(id, s) {
    const rows = await this.#find("flow-state", "flow_id", id);
    const data = { flow_id: id, status: s.status, active: s.active ?? null, reason: s.reason || "", since: s.since || 0 };
    if (rows[0]) await this.k.records.update(this.chain, "flow-state", rows[0].id, { ...data, active: s.active === undefined ? rows[0].data.active : s.active }, rows[0].version);
    else await this.k.records.create(this.chain, "flow-state", data);
  }

  /** @param {any} row @param {number} version */
  async #viewOf(row, version) {
    const defs = await this.#find("def-flow", "flow_id", row.data.flow_id);
    const v = defs.find((/** @type {any} */ r) => Number(r.data.version) === version);
    if (!v) return null;
    const aps = (await this.#find("flow-approval", "flow_id", row.data.flow_id)).filter((/** @type {any} */ a) => Number(a.data.version) === version && a.data.hash === v.data.hash);
    const ap = aps.sort((/** @type {any} */ a, /** @type {any} */ b) => Number(b.data.at) - Number(a.data.at))[0];
    const [kind, ...rest] = ap ? String(ap.data.approver).split(":") : [];
    return { id: row.data.flow_id, space: v.data.space, version, hash: v.data.hash, flow: JSON.parse(v.data.body), approver: ap ? { kind, id: rest.join(":"), space: v.data.space } : null, approved_at: ap ? Number(ap.data.at) : null, status: row.data.status };
  }

  /** @param {string} id */
  async active(id) {
    const st = (await this.#find("flow-state", "flow_id", id))[0];
    if (!st || st.data.active === null || st.data.status !== "active") return null;
    return this.#viewOf(st, Number(st.data.active));
  }
  /** @param {string} id @param {number} version */
  async getVersion(id, version) { const st = (await this.#find("flow-state", "flow_id", id))[0] || { data: { flow_id: id, status: "draft" } }; return this.#viewOf(st, version); }
  async activeFlows() {
    const r = await this.k.records.query(this.chain, "flow-state", { filter: { field: "status", op: "eq", value: "active" }, page: { limit: 1000 } });
    const out = [];
    for (const st of r.rows) if (st.data.active !== null) { const v = await this.#viewOf(st, Number(st.data.active)); if (v && v.approver) out.push(v); }
    return out;
  }
  /** @param {string} id @param {string} reason @param {number} at */
  async pause(id, reason, at) { await this.#known(id); await this.#setState(id, { status: "paused", reason, since: at, active: undefined }); }
  /** Flows with an approved version that are paused: a trigger that arrives for one is held, not lost. */
  async pausedFlows() {
    const r = await this.k.records.query(this.chain, "flow-state", { filter: { field: "status", op: "eq", value: "paused" }, page: { limit: 1000 } });
    const out = [];
    for (const st of r.rows) if (st.data.active !== null) { const v = await this.#viewOf(st, Number(st.data.active)); if (v && v.approver) out.push({ ...v, paused: true }); }
    return out;
  }
  /** @param {string} flow */
  async getTests(flow) { const r = (await this.#find("flow-tests", "flow_id", flow))[0]; return r ? JSON.parse(r.data.body) : []; }
  /** @param {string} flow @param {any[]} cases */
  async putTests(flow, cases) {
    const r = (await this.#find("flow-tests", "flow_id", flow))[0];
    const data = { flow_id: flow, body: JSON.stringify(cases) };
    if (r) await this.k.records.update(this.chain, "flow-tests", r.id, data, r.version); else await this.k.records.create(this.chain, "flow-tests", data);
  }
  /** The Space-wide switch (pause all, drain): null when nothing was ever set. */
  async getControl() { const r = (await this.#find("flow-control", "key", "space"))[0]; return r ? JSON.parse(r.data.body) : null; }
  /** @param {any} c */
  async putControl(c) {
    const r = (await this.#find("flow-control", "key", "space"))[0];
    const data = { key: "space", mode: c.mode, since: c.since || 0, body: JSON.stringify(c) };
    if (r) await this.k.records.update(this.chain, "flow-control", r.id, data, r.version); else await this.k.records.create(this.chain, "flow-control", data);
  }
  /** @param {string} id */
  async resume(id) { await this.#known(id); await this.#setState(id, { status: "active", reason: "", since: 0, active: undefined }); }
  /** @param {string} id */
  async disable(id) { await this.#setState(id, { status: "disabled", active: null }); }
  /** The Flow with its versions (newest last), as the memory store keeps it. @param {string} id */
  async flowRow(id) {
    const defs = await this.#find("def-flow", "flow_id", id);
    if (!defs.length) return null;
    const st = (await this.#find("flow-state", "flow_id", id))[0];
    const versions = defs.map((/** @type {any} */ d) => ({ version: Number(d.data.version), hash: d.data.hash, at: Number(d.data.at) || 0 })).sort((/** @type {any} */ a, /** @type {any} */ b) => a.version - b.version);
    return { id, name: defs[0].data.name, space: defs[0].data.space, versions, active: st && st.data.active !== null ? Number(st.data.active) : null, status: st ? st.data.status : "draft" };
  }
  async list() {
    const r = await this.k.records.query(this.chain, "flow-state", { page: { limit: 1000 } });
    return r.rows.map((/** @type {any} */ s) => ({ id: s.data.flow_id, status: s.data.status, active: s.data.active, paused: s.data.status === "paused" ? { reason: s.data.reason || "", since: Number(s.data.since) || 0 } : null }));
  }

  /** @param {string} flow @returns {Promise<number|null>} */
  async getSchedule(flow) { const r = (await this.#find("flow-schedule", "flow_id", flow))[0]; return r ? Number(r.data.last_fire) : null; }
  /** @param {string} flow @param {number} lastFire */
  async putSchedule(flow, lastFire) {
    const r = (await this.#find("flow-schedule", "flow_id", flow))[0];
    if (r) await this.k.records.update(this.chain, "flow-schedule", r.id, { last_fire: lastFire }, r.version);
    else await this.k.records.create(this.chain, "flow-schedule", { flow_id: flow, last_fire: lastFire });
  }

  /** @param {Run} run */
  async putRun(run) {
    const body = JSON.stringify(run);
    const known = this.ids.get(run.id);
    const data = { run_id: run.id, flow_id: run.flow, state: run.state, started_at: run.started_at, body, ...(run.label ? { title: run.label } : {}), ...(run.record ? { record: { urn: run.record } } : {}) };
    // The link is a courtesy to the record's timeline: a record that is gone (or a home whose type has no `record` field yet) must not lose the run itself.
    const write = async (/** @type {any} */ d) => {
      if (known) {
        const cur = await this.k.records.get(this.chain, "flow-run", known);
        if (cur) { await this.k.records.update(this.chain, "flow-run", known, d, cur.version); return; }
      }
      const found = (await this.#find("flow-run", "run_id", run.id))[0];
      if (found) { this.ids.set(run.id, found.id); await this.k.records.update(this.chain, "flow-run", found.id, d, found.version); return; }
      const rec = await this.k.records.create(this.chain, "flow-run", d);
      this.ids.set(run.id, rec.id);
    };
    try { await write(data); }
    catch (e) {
      if (!(e && /** @type {any} */ (e).code === "bad_input" && data.record)) throw e;
      const { record: _gone, ...bare } = data;
      await write(bare);
    }
  }
  /** @param {string} id @returns {Promise<Run|null>} */
  async getRun(id) { const f = (await this.#find("flow-run", "run_id", id))[0]; return f ? JSON.parse(f.data.body) : null; }
  /** @param {{ flow?: string, state?: string, before?: number, limit?: number }} [f] @returns {Promise<Run[]>} */
  async listRuns(f = {}) {
    /** @type {any[]} */ const and = [];
    if (f.flow) and.push({ field: "flow_id", op: "eq", value: f.flow });
    if (f.state) and.push({ field: "state", op: "eq", value: f.state });
    if (f.before !== undefined) and.push({ field: "started_at", op: "lt", value: f.before });
    const r = await this.k.records.query(this.chain, "flow-run", { filter: and.length ? { and } : undefined, sort: [{ field: "started_at", dir: "desc" }], page: { limit: f.limit || 200 } });
    return r.rows.map((/** @type {any} */ x) => JSON.parse(x.data.body));
  }
}
