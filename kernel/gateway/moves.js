// @ts-check
// kernel/gateway/moves.js: moving a project from one Space to another of the same person's, both hosted by this home (flows' DESIGN-project-move.md). One act, one approval:
//   out(chainFrom, { to, project, plan_hash }, { presence })  verified ONCE, in the SOURCE Space's sealing process (the proof is bound to the exact input: the target, the project and the plan hash, so the person
//                                                              approves what they were shown), then writes `project.move_started` in the source's log and answers { move_id }.
//   in(chainTo, { from, project, plan_hash, move_id })        in the TARGET Space, under the same person's chain there (an owner or admin of that Space: the ordinary role check, no second proof). It
//                                                              reads the SOURCE log (this home holds both) for that move: the same person started it, for this target, this project and this plan, within an hour, and it was never
//                                                              received. Then it writes `project.move_in` (single use) in the target's log.
// Nothing here copies a record or a file: that is the Flow's, under the mover's chains. A remote target has no shared log and is not supported.
import { KernelError } from "../core/errors.js";
import { isChain } from "../core/chain.js";
import { mintUuid, isUuid } from "../core/ids.js";

const SPACE = /^spc_[a-z2-7]{12}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const WINDOW_MS = 60 * 60 * 1000;
const bad = (/** @type {string} */ m) => new KernelError("bad_input", m);

/**
 * @param {{ space: string, gate: (chain: any, action: string, resource: string, opts?: any) => Promise<any>, log: any, clock: () => number, sha256: (s: string) => string, canonical: (v: any) => string,
 *   evidence?: (from: string, move_id: string) => Promise<any> | any }} cfg `evidence(from, move_id)` finds the `project.move_started` event in the SOURCE Space's log (this home hosts it), or null
 */
export function createMoves(cfg) {
  const { space, gate, log, clock } = cfg;
  const person = (/** @type {any} */ chain) => { if (!isChain(chain) || chain.viewer === true || chain.hops.length !== 1 || chain.hops[0].actor.kind !== "person") throw new KernelError("chain_not_person", "only a person moves a project, on their own"); return chain.hops[0].actor; };
  /** A project urn of the Space it is asked in. @param {string} u @param {string} sp */
  const projectOf = (u, sp) => { const p = String(u).split("/"); if (p.length !== 5 || p[0] !== "vyre:" || p[2] !== sp || p[3] !== "project" || !isUuid(p[4])) throw bad("a project is a project record urn of the Space it is asked in"); return u; };
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
    async in(/** @type {any} */ chain, /** @type {{ from: string, project: string, plan_hash: string, move_id: string }} */ i) {
      const who = person(chain);
      if (!i || !SPACE.test(String(i.from)) || i.from === space) throw bad("name the other Space of this home the project comes from");
      if (!isUuid(String(i.move_id)) || !HASH.test(String(i.plan_hash))) throw bad("a received move names its move id and plan hash");
      const project = projectOf(i.project, i.from);
      // the ordinary role check here: owner or admin of THIS Space (no proof: the approval was given where the move started)
      const d = await gate(chain, "project.move_in", `vyre://${space}/project/${i.move_id}`);
      if (typeof cfg.evidence !== "function") throw new KernelError("unavailable", "this home cannot read the other Space's log");
      const ev = await cfg.evidence(i.from, i.move_id);
      // everything the source's event says must be exactly this: the same person, this project, this target, this plan, recent
      const said = ev && ev.data;
      const sameActor = ev && typeof ev.actor === "string" && ev.actor.startsWith(`person:${who.id}@`);
      if (!said || !sameActor || ev.subject !== project || said.to !== space || said.plan_hash !== i.plan_hash || !(clock() - Number(ev.time) <= WINDOW_MS) || !(clock() >= Number(ev.time) - 60_000)) throw new KernelError("not_found", "no such move");
      if (log.read({ type: "project.move_in" }).some((/** @type {any} */ e) => e.data && e.data.move_id === i.move_id)) throw new KernelError("invalid", "this move was already received here");
      log.append(chain, { type: "project.move_in", sv: 1, subject: `vyre://${space}/project/${i.move_id}`, data: { move_id: i.move_id, from: i.from, project, plan_hash: i.plan_hash } }, { decision: d.decision });
      return { received: true, move_id: i.move_id };
    },
  });
}
