// @ts-check
// @Engineer (contract 9.3): a built-in assistant in every Space that only admins can talk to. It writes definitions as TypeScript, simulates them and
// proposes a diff card; an admin's own approval, with a presence proof over the card's hash, is what lets the kernel apply it. This file never applies
// a change with the Engineer's chain: `approve` calls the gateway under the admin's own chain, and only after the kernel accepted the approval.

import { propose, evaluate, refusal } from "./propose.js";
import { diffCard } from "./card.js";

const OUTWARD = /(^|\.)(send|pay|publish|delete|share)$/;

/** @param {string} space */
export const engineerActor = space => ({ kind: /** @type {const} */ ("agent"), id: "engineer", space });

/**
 * What the Engineer holds: read and define on definitions and ask for a person's approval. The model door is the kernel's own (it is not a registry action). Nothing that sends, pays, publishes,
 * shares or deletes, and nothing on the vault.
 * @param {string} space
 */
export function engineerGrants(space) {
  const subject = { kind: /** @type {const} */ ("actor"), actor: engineerActor(space) };
  return [
    { subject, actions: ["records.read", "records.define"], resource: { prefix: `vyre://${space}/definition` }, conditions: {}, source: "builtin:engineer", reason: "change definitions" },
    { subject, actions: ["tasks.request", "tasks.work"], resource: { prefix: `vyre://${space}/task` }, conditions: {}, source: "builtin:engineer", reason: "ask an admin to approve" },
  ];
}

/** The actions in a grant set that the Engineer must never hold. @param {readonly { actions: readonly string[] }[]} grants */
export const forbiddenInGrants = grants => grants.flatMap(g => g.actions).filter(a => a === "*" || OUTWARD.test(a) || a.startsWith("vault.") || a.startsWith("seal."));

/**
 * @param {{ kernel: any, compile: import("./propose.js").CompilePort, simulate?: import("./simulate.js").SimulatePort|null,
 *   engineerChain?: (chain: any) => any, model?: { provider: string, model: string } }} o
 * `engineerChain(chain)` is the kernel's chain for the Engineer acting for that admin ([person, agent:engineer]); the default is the admin's own chain.
 */
export function createEngineer({ kernel, compile, simulate = null, engineerChain = c => c, model }) {
  /** @type {Map<string, { proposal: any, task: string, admin: string, state: "open"|"superseded"|"applied"|"rejected" }>} */
  const proposals = new Map();
  let n = 0;

  /** Only an admin, and the refusal looks like absence. @param {any} chain */
  function requireAdmin(chain) {
    const first = chain && chain.hops && chain.hops[0];
    // Exactly one person: an assistant acting for an admin is not the admin (the Engineer's own chain is built inside, beside the admin).
    if (!first || chain.hops.length !== 1 || first.actor.kind !== "person" || !kernel.members || !kernel.members.isAdmin(first.actor)) throw refusal("not_found", "not found");
    return first.actor;
  }

  /** The task an admin sees: the Engineer is the doer, the admin the checker, and the task binds the card's hash. @param {any} echain @param {any} admin @param {any} p */
  async function raiseTask(echain, admin, p) {
    // The real kernel binds an approval to the evidence the doer completes with, so the card's hash rides in it; the fake kernel binds `draft_hash` instead.
    const real = typeof kernel.ask.complete === "function";
    const task = await kernel.ask.request(echain, { title: `Review a change to your definitions: ${p.summary}`.slice(0, 200), doer: engineerActor(echain.space), checker: admin,
      output: { kind: "decision" }, source: "assistant_request", ...(real ? {} : { draft_hash: p.hash }) });
    if (real) {
      await kernel.ask.start(echain, task.id);
      await kernel.ask.complete(echain, task.id, { answer: "yes", reason: `Change to definitions, card ${p.hash}`, proposal_hash: p.hash });
    } else if (kernel.tasks) {
      await kernel.tasks.move(echain, task.id, "working");
      await kernel.tasks.move(echain, task.id, "needs_check", { output_checked: true });
    }
    return task.id;
  }

  /** @param {any} p @param {string} note */
  const cardOf = (p, note = "") => diffCard({ ...p, note: note || p.note });

  const self = {
    /** Say what should change; returns the card. Nothing is applied. @param {any} chain @param {string} request */
    async propose(chain, request) {
      const admin = requireAdmin(chain);
      const echain = engineerChain(chain);
      const p = await propose({ kernel, compile, simulate, chain: echain, adminChain: chain, request, ...(model ? { model } : {}) });
      const task = await raiseTask(echain, admin, p);
      const id = `prop_${(++n).toString(36)}_${p.hash.slice(0, 8)}`;
      proposals.set(id, { proposal: p, task, admin: admin.id, state: "open" });
      return { id, task, card: cardOf(p), proposal: p };
    },

    /** The admin edits the text themselves: it goes through the same checks, gets its own hash and task, and voids the earlier approval. @param {any} chain @param {string} id @param {string} source */
    async revise(chain, id, source) {
      const admin = requireAdmin(chain);
      const rec = proposals.get(id);
      if (!rec || rec.admin !== admin.id || rec.state !== "open") throw refusal("not_found", "not found");
      const echain = engineerChain(chain);
      const p = await evaluate({ kernel, compile, simulate, chain: echain, adminChain: chain, source, authorship: "edited" });
      rec.state = "superseded";
      const task = await raiseTask(echain, admin, p);
      const nid = `prop_${(++n).toString(36)}_${p.hash.slice(0, 8)}`;
      proposals.set(nid, { proposal: p, task, admin: admin.id, state: "open" });
      return { id: nid, task, card: cardOf(p), proposal: p, superseded: id };
    },

    /**
     * The admin's approval. Accepted only from a chain that is exactly the admin: the kernel checks the presence proof against the task, which binds the
     * card's hash. The text is compiled again and must still have the hash that was shown. The change is applied under the admin's own chain.
     * @param {any} chain @param {string} id @param {{ proof: any, outcome?: "approved"|"rejected", reason?: string }} approval
     */
    async approve(chain, id, { proof, outcome = "approved", reason }) {
      const admin = requireAdmin(chain);
      if (chain.hops.length !== 1) throw refusal("chain_not_person", "approval is the admin's own, with nothing acting between");
      const rec = proposals.get(id);
      if (!rec || rec.admin !== admin.id) throw refusal("not_found", "not found");
      if (rec.state !== "open") throw refusal("void", rec.state === "superseded" ? "this change was edited after it was shown: review the new card" : "this change was already decided");
      if (outcome === "approved") {
        const again = await compile(rec.proposal.source);
        if (again.hash !== rec.proposal.hash || (again.errors && again.errors.length)) { rec.state = "superseded"; throw refusal("hash_changed", "the definition no longer matches the card that was shown: review it again"); }
      }
      const task = await kernel.ask.decide(chain, rec.task, { outcome, ...(reason ? { reason } : {}), proof });
      if (outcome === "rejected") { rec.state = "rejected"; return { applied: false, task }; }
      const done = await kernel.records.define(chain, rec.proposal.diff);
      rec.state = "applied";
      return { applied: done.applied, changes: done.changes, task };
    },

    /** Say in plain words what a definition is and how it came to be: the stored definition from `definitions`, who and when from the kernel's `types.defined` events. @param {any} chain @param {string} name */
    async explain(chain, name) {
      requireAdmin(chain);
      const events = await kernel.events.read(chain, { type: "types.defined" });
      const history = [];
      for (const e of events) {
        for (const c of (e.data && Array.isArray(e.data.changes) ? e.data.changes : [])) {
          const m = /^(added|changed|removed) type (\S+)/.exec(String(c));
          if (m && m[2] === name) history.push({ at: e.time, by: e.actor, what: m[1] });
        }
      }
      const current = (await kernel.definitions(chain)).find((/** @type {any} */ t) => t.name === name) || null;
      if (!history.length && !current) return { name, found: false, text: `There is no definition called ${name}.`, history };
      const fields = current ? (current.fields || []).map((/** @type {any} */ f) => f.label || f.name) : [];
      const stages = current ? (current.stages || []).map((/** @type {any} */ s) => s.name) : [];
      const last = history[history.length - 1];
      const by = last ? String(last.by).replace(/@.*$/, "") : "";
      const text = current
        ? `${name} has ${fields.length} fields${fields.length ? ` (${fields.join(", ")})` : ""}${stages.length ? ` and the stages ${stages.join(", ")}` : ""}.${last ? ` It was last ${last.what} by ${by}.` : ""}`
        : `${name} was removed by ${by}.`;
      return { name, found: true, text, history, definition: current };
    },

    /** The Engineer's one door for an admin's words: "explain X" or a request for a change. @param {any} chain @param {string} text */
    async talk(chain, text) {
      requireAdmin(chain);
      const m = /^\s*explain\s+(.+?)\s*$/i.exec(String(text));
      if (m) return { kind: "explain", ...(await self.explain(chain, m[1])) };
      return { kind: "proposal", ...(await self.propose(chain, text)) };
    },

    /** For tests and the Deck: the open proposal's card. @param {string} id */
    card(id) { const r = proposals.get(id); return r ? cardOf(r.proposal) : null; },
  };
  return self;
}
