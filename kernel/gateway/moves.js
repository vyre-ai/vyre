// @ts-check
// kernel/gateway/moves.js: moving a project from one Space to another of the same person's, both hosted by this home (flows' DESIGN-project-move.md). One act, one approval:
//   out(chainFrom, { to, project, plan_hash }, { presence })  verified ONCE, in the SOURCE Space's sealing process (the proof is bound to the exact input: the target, the project and the plan hash, so the person
//                                                              approves what they were shown), then writes `project.move_started` in the source's log and answers { move_id }.
//   in(chainTo, { from, project, plan_hash, move_id })        in the TARGET Space, under the same person's chain there (an owner or admin of that Space: the ordinary role check, no second proof). It
//                                                              reads the SOURCE log (this home holds both) for that move: the same person started it, for this target, this project and this plan, within an hour, and it was never
//                                                              received. Then it writes `project.move_in` (single use) in the target's log.
// Nothing here copies a record or a file: that is the Flow's, under the mover's chains.
// A target on ANOTHER home has no shared log, so it checks SIGNED evidence instead (reviewer-3's remote-move design, team/0.3/reviews/remote-move-design.md):
//   evidenceOf(chainFrom, { move_id })        in the SOURCE: the unsigned evidence { v, from, to, project, plan_hash, move_id, person, at } read from the source's own `project.move_started` event
//                                              (person chain only, rate limited, never from the caller). The spaces module signs it with the Space key (spaces.moves.evidence).
//   in(chainTo, { from, project, plan_hash, move_id, bundle })   `bundle` is { evidence, pub, sig }; `cfg.remoteEvidence` (the spaces module) verifies it against the source Space's directory key and answers the
//                                              verified evidence, which is then held to exactly the same checks as a local event. Window: it governs STARTING (receiving); a pull outlives it (RM-3).
//   finishTarget(chainTo, { move_id, counts, files_root })   in the TARGET after the copy: writes `project.move_done` and answers the receipt body the spaces module signs with the TARGET key.
//   finishSource(chainFrom, { move_id, receipt })            in the SOURCE: `cfg.verifyReceipt` checks the receipt against the target Space's directory key; only then `project.moved` is written, and
//                                              only then may the Flow remove anything from the source (RM-4).
import { KernelError } from "../core/errors.js";
import { isChain } from "../core/chain.js";
import { mintUuid, isUuid } from "../core/ids.js";

const SPACE = /^spc_[a-z2-7]{12}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const WINDOW_MS = 60 * 60 * 1000;
const EVIDENCE_PER_MIN = 10;
const EVIDENCE_KEYS = ["v", "from", "to", "project", "plan_hash", "move_id", "person", "at"];
const bad = (/** @type {string} */ m) => new KernelError("bad_input", m);

/**
 * @param {{ space: string, gate: (chain: any, action: string, resource: string, opts?: any) => Promise<any>, log: any, clock: () => number, sha256: (s: string) => string, canonical: (v: any) => string,
 *   evidence?: (from: string, move_id: string) => Promise<any> | any, remoteEvidence?: (bundle: any, c: { from: string, to: string }) => Promise<any> | any,
 *   verifyReceipt?: (receipt: any, c: { from: string, to: string }) => Promise<any> | any }} cfg `evidence(from, move_id)` finds the `project.move_started` event in the SOURCE Space's log (this home hosts it), or null
 */
export function createMoves(cfg) {
  const { space, gate, log, clock } = cfg;
  const person = (/** @type {any} */ chain) => { if (!isChain(chain) || chain.viewer === true || chain.hops.length !== 1 || chain.hops[0].actor.kind !== "person") throw new KernelError("chain_not_person", "only a person moves a project, on their own"); return chain.hops[0].actor; };
  /** A project urn of the Space it is asked in. @param {string} u @param {string} sp */
  const projectOf = (u, sp) => { const p = String(u).split("/"); if (p.length !== 5 || p[0] !== "vyre:" || p[2] !== sp || p[3] !== "project" || !isUuid(p[4])) throw bad("a project is a project record urn of the Space it is asked in"); return u; };
  /** @type {Map<string, number[]>} evidence requests per person, last minute */ const evidenceCalls = new Map();
  const overRate = (/** @type {string} */ who) => { const now = clock(); const l = (evidenceCalls.get(who) || []).filter(t => now - t < 60_000); l.push(now); evidenceCalls.set(who, l); return l.length > EVIDENCE_PER_MIN; };
  const startedEvent = (/** @type {string} */ move_id) => log.read({ type: "project.move_started" }).find((/** @type {any} */ e) => e.data && e.data.move_id === move_id) ?? null;
  return Object.freeze({
    /** The input the approval covers (the surface builds the proof request from the same value: kernel/remote/proof.js `moveOut`). @param {string} to @param {string} plan_hash */
    inputOf: (to, plan_hash) => ({ to, plan_hash }),
    async out(/** @type {any} */ chain, /** @type {{ to: string, project: string, plan_hash: string }} */ i, /** @type {{ presence?: any }} */ o = {}) {
      const who = person(chain);
      if (!i || !SPACE.test(String(i.to)) || i.to === space) throw bad("name another Space of this home to move the project to");
      if (!HASH.test(String(i.plan_hash))) throw bad("a move names the plan hash the person approved");
      const project = projectOf(i.project, space);
      // one proof, bound to this input, spent by the sealing process: a second `out` with the same proof is refused there
      const d = await gate(chain, "project.move_out", project, { presence: o.presence, input_hash: cfg.sha256(cfg.canonical({ action: "project.move_out", input: { to: i.to, plan_hash: i.plan_hash } })) });
      const move_id = mintUuid(clock());
      log.append(chain, { type: "project.move_started", sv: 1, subject: project, data: { move_id, to: i.to, plan_hash: i.plan_hash } }, { decision: d.decision });
      void who;
      return { move_id };
    },
    /**
     * The batch form of `out`, for an upgrade that moves several projects at once: ONE approval and ONE plan hash cover every project. The proof is bound to the target, the plan hash and the sorted
     * list of projects (kernel/remote/proof.js `moveOutMany`), so the person approves exactly what they were shown. Then each project gets its own `project.move_started` (and move id), and each is
     * received with the ordinary `in`: single use, the same window, nothing here copies a record. Every project is checked before the proof is spent. At most 100.
     */
    async outMany(/** @type {any} */ chain, /** @type {{ to: string, projects: string[], plan_hash: string }} */ i, /** @type {{ presence?: any }} */ o = {}) {
      person(chain);
      if (!i || !SPACE.test(String(i.to)) || i.to === space) throw bad("name another Space of this home to move the projects to");
      if (!HASH.test(String(i.plan_hash))) throw bad("a move names the plan hash the person approved");
      if (!Array.isArray(i.projects) || i.projects.length < 1 || i.projects.length > 100) throw bad("a batch moves between 1 and 100 projects");
      const projects = i.projects.map(p => projectOf(p, space));
      if (new Set(projects).size !== projects.length) throw bad("a project is named once in a batch");
      const sorted = [...projects].sort();
      const d = await gate(chain, "project.move_out", `vyre://${space}/project/batch`, { presence: o.presence, input_hash: cfg.sha256(cfg.canonical({ action: "project.move_out", input: { to: i.to, plan_hash: i.plan_hash, projects: sorted } })) });
      const batch = mintUuid(clock());
      /** @type {{ project: string, move_id: string }[]} */ const moves = [];
      for (const project of projects) {
        const move_id = mintUuid(clock());
        log.append(chain, { type: "project.move_started", sv: 1, subject: project, data: { move_id, to: i.to, plan_hash: i.plan_hash, batch } }, { decision: d.decision });
        moves.push({ project, move_id });
      }
      return { batch, moves };
    },
    /**
     * The unsigned evidence for a move that started in THIS Space, for the spaces module to sign. Only the exactly-one-person chain that started it; read from this Space's own log and never from the caller;
     * an event written on the person's behalf (`acted_via`) is no evidence. Rate limited. The field set and order are fixed, `v` is 1. @returns {{ v: 1, from: string, to: string, project: string, plan_hash: string, move_id: string, person: string, at: number }}
     */
    evidenceOf(/** @type {any} */ chain, /** @type {{ move_id: string }} */ i) {
      const who = person(chain);
      if (overRate(who.id)) throw new KernelError("rate_limited", "too many requests for move evidence; wait a moment");
      if (!i || !isUuid(String(i.move_id))) throw bad("name the move");
      const ev = startedEvent(i.move_id);
      const said = ev && ev.data;
      if (!ev || !said || ev.acted_via !== undefined || typeof ev.actor !== "string" || !ev.actor.startsWith(`person:${who.id}@`)) throw new KernelError("not_found", "no such move started here by you");
      return { v: 1, from: space, to: said.to, project: ev.subject, plan_hash: said.plan_hash, move_id: i.move_id, person: who.id, at: Number(ev.time) };
    },
    async in(/** @type {any} */ chain, /** @type {{ from: string, project: string, plan_hash: string, move_id: string }} */ i) {
      const who = person(chain);
      if (!i || !SPACE.test(String(i.from)) || i.from === space) throw bad("name the other Space of this home the project comes from");
      if (!isUuid(String(i.move_id)) || !HASH.test(String(i.plan_hash))) throw bad("a received move names its move id and plan hash");
      const project = projectOf(i.project, i.from);
      // the ordinary role check here: owner or admin of THIS Space (no proof: the approval was given where the move started)
      const d = await gate(chain, "project.move_in", `vyre://${space}/project/${i.move_id}`);
      /** @type {any} */ let ev;
      if (i.bundle !== undefined && i.bundle !== null) {
        // another home: SIGNED evidence, verified against the source Space's own published key by the spaces module (never a key the caller hands over). What comes back is shaped like the local event.
        if (typeof cfg.remoteEvidence !== "function") throw new KernelError("unavailable", "this home cannot check evidence from another home");
        const v = await cfg.remoteEvidence(i.bundle, { from: i.from, to: space });
        const e = v && typeof v === "object" ? v : null;
        if (!e || Object.keys(e).some(k => !EVIDENCE_KEYS.includes(k)) || e.v !== 1 || e.from !== i.from || e.to !== space || e.move_id !== i.move_id || e.person !== who.id) throw new KernelError("not_found", "that evidence is not for this move");
        ev = { actor: `person:${e.person}@${i.from}`, subject: e.project, time: e.at, data: { move_id: e.move_id, to: e.to, plan_hash: e.plan_hash } };
      } else {
        if (typeof cfg.evidence !== "function") throw new KernelError("unavailable", "this home cannot read the other Space's log");
        ev = await cfg.evidence(i.from, i.move_id);
      }
      // an event written on the person's behalf by an assistant (`acted_via`) is never the person's own approval (reviewer-3). Everything the source's event says must be exactly this: the same person, this project, this target, this plan, recent
      const said = ev && ev.data;
      const sameActor = ev && typeof ev.actor === "string" && ev.actor.startsWith(`person:${who.id}@`);
      if (!said || !sameActor || ev.acted_via !== undefined || ev.subject !== project || said.to !== space || said.plan_hash !== i.plan_hash || !(clock() - Number(ev.time) <= WINDOW_MS) || !(clock() >= Number(ev.time) - 60_000)) throw new KernelError("not_found", "no such move");
      if (log.read({ type: "project.move_in" }).some((/** @type {any} */ e) => e.data && e.data.move_id === i.move_id)) throw new KernelError("invalid", "this move was already received here");
      log.append(chain, { type: "project.move_in", sv: 1, subject: `vyre://${space}/project/${i.move_id}`, data: { move_id: i.move_id, from: i.from, project, plan_hash: i.plan_hash } }, { decision: d.decision });
      return { received: true, move_id: i.move_id };
    },
    /**
     * In the TARGET, after the copy is verified: the move is done here. Needs the `project.move_in` this Space wrote for this move, by this person. Writes `project.move_done` (counts and the root of the
     * per-file hashes only) and answers the receipt body `{ v, move_id, from, to, counts, files_root, at }` that the spaces module signs with this Space's key. A second call answers the same receipt.
     */
    async finishTarget(/** @type {any} */ chain, /** @type {{ move_id: string, counts: any, files_root: string }} */ i) {
      const who = person(chain);
      if (!i || !isUuid(String(i.move_id))) throw bad("name the move");
      if (!HASH.test(String(i.files_root)) && !/^[0-9a-f]{64}$/.test(String(i.files_root))) throw bad("a finished move names the root hash of its per-file hashes");
      if (!i.counts || typeof i.counts !== "object" || Array.isArray(i.counts)) throw bad("a finished move names its counts");
      const d = await gate(chain, "project.move_finish", `vyre://${space}/project/${i.move_id}`);
      const got = log.read({ type: "project.move_in" }).find((/** @type {any} */ e) => e.data && e.data.move_id === i.move_id);
      if (!got || typeof got.actor !== "string" || !got.actor.startsWith(`person:${who.id}@`)) throw new KernelError("not_found", "this Space received no such move from you");
      const done = log.read({ type: "project.move_done" }).find((/** @type {any} */ e) => e.data && e.data.move_id === i.move_id);
      const at = done ? Number(done.time) : clock();
      if (!done) log.append(chain, { type: "project.move_done", sv: 1, subject: got.subject, data: { move_id: i.move_id, from: got.data.from, counts: i.counts, files_root: i.files_root } }, { decision: d.decision });
      const rec = done ? done.data : { from: got.data.from, counts: i.counts, files_root: i.files_root };
      return { v: 1, move_id: i.move_id, from: rec.from, to: space, counts: rec.counts, files_root: rec.files_root, at };
    },
    /**
     * In the SOURCE: the target's signed receipt for this move arrives, `cfg.verifyReceipt` (the spaces module) checks it against the TARGET Space's published key, and only then is `project.moved` written.
     * A Flow may remove what moved from the source only after this answers. The receipt must name this move, this Space as the source and the target the approval named.
     */
    async finishSource(/** @type {any} */ chain, /** @type {{ move_id: string, receipt: any }} */ i) {
      const who = person(chain);
      if (!i || !isUuid(String(i.move_id))) throw bad("name the move");
      const ev = startedEvent(i.move_id);
      if (!ev || typeof ev.actor !== "string" || !ev.actor.startsWith(`person:${who.id}@`)) throw new KernelError("not_found", "no such move started here by you");
      const d = await gate(chain, "project.move_finish", ev.subject);
      if (typeof cfg.verifyReceipt !== "function") throw new KernelError("unavailable", "this home cannot check a receipt from another home");
      const r = await cfg.verifyReceipt(i.receipt, { from: space, to: ev.data.to });
      if (!r || r.v !== 1 || r.move_id !== i.move_id || r.from !== space || r.to !== ev.data.to) throw new KernelError("not_found", "that receipt is not for this move");
      const already = log.read({ type: "project.moved" }).find((/** @type {any} */ e) => e.data && e.data.move_id === i.move_id);
      if (!already) log.append(chain, { type: "project.moved", sv: 1, subject: ev.subject, data: { move_id: i.move_id, to: r.to, counts: r.counts, files_root: r.files_root } }, { decision: d.decision });
      return { moved: true, move_id: i.move_id, to: r.to, counts: r.counts, files_root: r.files_root };
    },
  });
}
