// @ts-check
// Proposals: what an assistant (the Engineer above all) may do with a change to the Space's shape. It may DRAFT: a Flow is stored unapproved by `flows.define`, a Kit is a card, a
// definition change is a diff held in a task. It may then PROPOSE: this file turns the draft into one task in Now, `form.kind: "proposal"`, for an owner or an admin to approve. It never
// applies anything. When the approver says yes (the kernel checks their presence on the task), the approval event arrives here and the change is applied under the APPROVER's own
// chain, built by the host, never under the assistant's. A proposal that cannot be applied says so on the task's own log and is dropped; it never half-applies.
//
//   what: "flow"   { id, version }          the stored draft; approval runs the same `approve` a person's `flows.approve` does, bound to the draft's hash
//   what: "types"  { diff }                 a DefineDiff for records.define; approval defines the types as the approver
//   (a Kit proposal keeps kits.js: its own card and `kit_install` task; this file only lets an assistant's chain ask for one)

const TYPE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_FORM = 6000;

const bad = (/** @type {string} */ message, code = "bad_input") => Object.assign(new Error(message), { code });

/**
 * The person an assistant's chain acts for, when the chain is a person with only assistants behind them (a person's own session narrowed to a model). A service, an automation or a
 * second person in the chain is nobody. @param {any} chain @returns {{ kind: string, id: string, space: string } | null}
 */
export function proposerOf(chain) {
  const hops = chain && chain.hops;
  if (!Array.isArray(hops) || !hops.length || hops[0].actor.kind !== "person") return null;
  if (hops.slice(1).some((/** @type {any} */ h) => h.actor.kind !== "agent")) return null;
  const a = hops[0].actor;
  return { kind: "person", id: a.id, space: a.space };
}

/** The assistant behind a chain, by name, or null when the person is acting alone. @param {any} chain */
export const assistantOf = chain => { const h = (chain && chain.hops || []).find((/** @type {any} */ x) => x.actor.kind === "agent"); return h ? String(h.actor.id) : null; };

export class Proposals {
  /**
   * @param {{ kernel: any, runner: any, store: any, chain: () => any, chains: { forFlow: (o: any) => any, forDoer?: (o: any) => any }, catalog: () => any, applyTypes?: ((approver: any, diff: any) => Promise<any>) | null,
   *   isAdmin?: ((who: any) => Promise<boolean> | boolean) | null, clock?: () => number, log?: (m: string) => void }} o
   */
  constructor(o) { this.k = o.kernel; this.runner = o.runner; this.store = o.store; this.chain = o.chain; this.chains = o.chains; this.catalogFn = o.catalog; this.applyTypes = o.applyTypes || null;
    this.isAdmin = o.isAdmin || null; /** @type {Map<string, Promise<any>>} per task, events are handled one after another */ this.queue = new Map(); this.now = o.clock || Date.now; this.log = o.log || (() => {}); /** @type {Set<string>} tasks already applied or dropped in this process */ this.settled = new Set(); }

  /**
   * Put a draft in front of an owner or an admin as one task in Now. The proposer is the person the call is for (an assistant's chain narrowed from them); they must be an owner or an
   * admin, or nobody is asked. Idempotent per draft: asking again for the same Flow version or the same diff returns the same task.
   * @param {any} chain the caller's chain @param {{ what: string, id?: string, version?: number, diff?: any, note?: string }} spec
   */
  async propose(chain, spec) {
    const approver = proposerOf(chain);
    if (!approver) throw bad("a proposal is made for a person, by that person or by their assistant", "chain_not_person");
    if (this.isAdmin && !(await this.isAdmin(approver))) throw Object.assign(new Error("only an owner or an admin approves a change to the Space, so only they are asked"), { code: "not_found" });
    const by = assistantOf(chain);
    /** @type {any} */ let form; let title; let idem;
    if (spec.what === "flow") {
      const v = await this.store.getVersion(String(spec.id || ""), Number(spec.version));
      if (!v) throw bad("no such Flow version", "not_found");
      if (v.approver) throw bad("that version is already approved");
      form = { kind: "proposal", what: "flow", flow: v.id, version: v.version, hash: v.hash, name: String(v.flow.label || v.flow.name || v.id).slice(0, 120), authorship: v.flow.authorship, ...(by ? { by } : {}) };
      title = `Approve the Flow "${form.name}"?`; idem = `proposal:flow:${v.id}:${v.version}:${v.hash}`;
    } else if (spec.what === "types") {
      const d = spec.diff;
      if (!d || typeof d !== "object" || Array.isArray(d)) throw bad("a definition change is a diff: { add_types?, change_types? }");
      const names = [...(d.add_types || []), ...(d.change_types || [])].map((/** @type {any} */ t) => t && t.name);
      if (!names.length || names.some((/** @type {any} */ n) => typeof n !== "string" || !TYPE_NAME.test(n))) throw bad("a definition change names the types it adds or changes");
      const json = JSON.stringify(d);
      if (json.length > MAX_FORM) throw bad("that change is too large for one card; split it into smaller proposals");
      form = { kind: "proposal", what: "types", diff: d, names, ...(by ? { by } : {}) };
      title = `Change your definitions: ${names.slice(0, 4).join(", ")}${names.length > 4 ? " and more" : ""}?`;
      idem = `proposal:types:${await sha(json)}`;
    } else throw bad("propose a flow or types (a Kit goes through flows.kit.propose)");
    if (spec.note) form.note = String(spec.note).slice(0, 500);
    // The way Kits ask: the Flows service is the doer and puts it in front of the approver with a yes, and the approver CHECKS: their approve or reject (with presence) is the answer.
    const key = idem.slice(-16).replace(/[^a-z0-9]/gi, "");
    const doerChain = this.chains.forDoer ? this.chains.forDoer({ proposal: key, space: approver.space, approver }) : null;
    const task = await this.k.ask.request(this.chains.forFlow({ flow: `proposal:${key}`, space: approver.space, approver, tainted: false, run: `prop_${key}`, source_spaces: [approver.space] }), {
      title: title.slice(0, 200), output: { kind: "decision" }, source: "manual", form,
      ...(doerChain ? { doer: { kind: "service", id: "flows", space: approver.space }, checker: approver } : { doer: approver }),
    }, { idem });
    if (doerChain) for (const [step, arg] of [["start"], ["complete", { answer: "yes", reason: `${title.replace(/\?$/, "")} is waiting for your yes` }]]) {
      try { await (step === "start" ? this.k.ask.start(doerChain, task.id) : this.k.ask.complete(doerChain, task.id, arg)); } catch (e) { if (!e || !["bad_state", "not_allowed"].includes(/** @type {any} */ (e).code)) throw e; }
    }
    return { ok: true, task: task.id, what: form.what, approver: approver.id, ...(by ? { by } : {}) };
  }

  /** The card a proposal's task must carry, recomputed from the store and the form's own data, never taken from the form's words. @param {any} form @returns {Promise<string | null>} the title, or null when the form does not describe a stored draft */
  async titleOf(form) {
    if (form.what === "flow") {
      const v = await this.store.getVersion(String(form.flow || ""), Number(form.version));
      if (!v || v.approver || v.hash !== form.hash) return null;
      return `Approve the Flow "${String(v.flow.label || v.flow.name || v.id).slice(0, 120)}"?`.slice(0, 200);
    }
    if (form.what === "types") {
      const names = namesOf(form.diff);
      if (!names) return null;
      return `Change your definitions: ${names.slice(0, 4).join(", ")}${names.length > 4 ? " and more" : ""}?`.slice(0, 200);
    }
    return null;
  }

  /**
   * A task event from the kernel. Only a task that is a proposal AND checks out is acted on: done and approved; the CHECKER is an owner or an admin (never the doer, never nobody: a task a
   * person wrote and completed for themselves applies nothing); the title says what the stored draft really is (a card that names one Flow and points at another applies nothing); the form's
   * hash is the stored version's. Applied as the checker, once: the task is claimed before anything is awaited, so two events for one task apply one change.
   * @param {any} env
   */
  async onEvent(env) {
    if (!/^task\./.test(env.type)) return null;
    const id = (env.data && (env.data.task || env.data.id)) || (typeof env.subject === "string" && /\/task\/[^/]+$/.test(env.subject) ? env.subject.slice(env.subject.lastIndexOf("/") + 1) : null);
    if (!id || this.settled.has(id)) return null;
    // One task's events are handled one after another, so two events for one approved task apply one change.
    const run = (this.queue.get(id) || Promise.resolve()).then(() => this.#handle(id));
    this.queue.set(id, run.catch(() => {}));
    try { return await run; } finally { if (this.settled.has(id)) this.queue.delete(id); }
  }

  /** @param {string} id */
  async #handle(id) {
    if (this.settled.has(id)) return null;
    {
      const row = await this.k.ask.get(this.chain(), id).catch(() => null);
      const form = row && row.form;
      if (!form || form.kind !== "proposal" || row.state !== "done") return null;
      if (this.settled.has(id)) return null;
      this.settled.add(id);
      if (row.outcome !== "approved") return { declined: form.what };
      const checker = row.checker;
      if (!checker || checker.kind !== "person" || (row.doer && row.doer.kind === "person" && row.doer.id === checker.id) || (this.isAdmin && !(await this.isAdmin(checker)))) { this.log(`proposal ${id} ignored: its checker is not an owner or an admin`); return { ignored: "not_admin_checked" }; }
      const want = await this.titleOf(form);
      if (want === null || want !== row.title) { this.log(`proposal ${id} ignored: its card does not match the stored draft`); return { ignored: "card_mismatch" }; }
      try {
        if (form.what === "flow") await this.runner.approve(form.flow, form.version, checker, form.hash);
        else if (form.what === "types") { if (!this.applyTypes) throw bad("this Space cannot apply definition changes here", "unavailable"); await this.applyTypes(checker, form.diff); }
        return { applied: form.what, task: id };
      } catch (e) { this.log(`proposal ${id} could not be applied: ${/** @type {Error} */ (e).message}`); return { failed: form.what, task: id, error: /** @type {Error} */ (e).message }; }
    }
  }
}

/** The type names a definition diff adds or changes, or null when it is not one. @param {any} d */
function namesOf(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const names = [...(d.add_types || []), ...(d.change_types || [])].map((/** @type {any} */ t) => t && t.name);
  return names.length && names.every((/** @type {any} */ n) => typeof n === "string" && TYPE_NAME.test(n)) ? names : null;
}

/** @param {string} s */
async function sha(s) { const { createHash } = await import("node:crypto"); return createHash("sha256").update(s).digest("hex").slice(0, 24); }
