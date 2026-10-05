// @ts-check
// Moving a Project to a Space on ANOTHER server (windows' remote form, team/0.3/DESIGN-project-move.md, "A move to a Space on another server" and its correction), and the upgrade from a Basic
// Personal space to My Cloud built on it. Nothing here carries the project's data: the device holds only the small signed handle, and the TARGET home pulls records, files and sealed blobs from the
// source home server to server. So this is a different shape from `runMove`, which pushes through two gateways of one home:
//
//   plan     the same `planMove`, with the target marked `remote: true` (its types and Drive are checked by the target when it receives)
//   out      the source Space's approval, once, bound to the plan hash                         ports.out(plan)             -> { move_id }
//   evidence the source Space's signed evidence of that approval                               ports.evidence(move_id)     -> { evidence, pub, sig }
//   receive  the target verifies the evidence against the directory and opens the move         ports.receive(bundle)       -> {}
//   pull     the target home pulls what the plan names from the source home                    ports.pull({ move_id, plan }) -> { target, map, counts, files: { path: sha256 } }
//   verify   counts and per-file hashes against the plan; nothing is removed on a mismatch
//   finish   the source empties and writes `project.moved`, the target writes `project.move_done`   ports.finish(side, { move_id, counts })
//
// Every step is idempotent behind `ports.state`, so a crash or a dropped connection resumes. The memory room goes sealed to a key the target made (ports.memory); the Work engine's lines ride in the
// pull (`pulled.know`). Whatever a build cannot carry is reported in the answer, never silently dropped, and the source keeps it.
import crypto from "node:crypto";
import { planMove } from "./project-move.js";

const urnParts = (/** @type {string} */ u) => { const [, , space, type, id] = String(u).split("/"); return { space, type, id }; };
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ from: any, to: { space: string }, project: string, client?: "move" | "leave" }} o `from` is a side of the source home (records, drive, chain); `to` only names the remote Space
 */
export const planRemoteMove = ({ from, to, project, client }) => planMove({ from, to: { ...to, remote: true }, project, client });

/**
 * @param {{ from: any, to: { space: string }, plan: any, ports: { out: Function, evidence: Function, receive: Function, pull: Function, finish: Function, removeFiles?: Function, onStep?: (n: string) => void, state?: any } }} o
 */
export async function runRemoteMove({ from, to, plan, ports }) {
  if (plan.blockers.length) throw fail("blocked", `this move cannot run: ${plan.blockers.join("; ")}`);
  const state = ports.state || (ports.state = {});
  const step = (/** @type {string} */ n) => { if (ports.onStep) ports.onStep(n); };
  const { type, id } = urnParts(plan.project);
  // once the target has pulled and verified, the source is being emptied, so a resume must not re-plan it
  if (!state.verified) {
    const again = await planMove({ from, to: { ...to, remote: true }, project: plan.project, client: plan.client });
    if (again.hash !== plan.hash) throw fail("stale_plan", "the project changed since it was approved; plan the move again");
  }
  if (!state.move_id) { step("out"); const o = await ports.out(plan); state.move_id = o.move_id; }
  if (!state.bundle) { step("evidence"); state.bundle = await ports.evidence(state.move_id); }
  if (!state.received) { step("receive"); await ports.receive({ ...state.bundle, move_id: state.move_id, plan_hash: plan.hash, project: plan.project, from: from.space }); state.received = true; }
  if (!state.pulled) { step("pull"); state.pulled = await ports.pull({ move_id: state.move_id, plan }); }
  if (!state.verified) {
    step("verify");
    const got = state.pulled;
    const want = plan.counts;
    const recs = Object.values(want.records || {}).reduce((/** @type {number} */ n, /** @type {any} */ c) => n + Number(c), 0);
    const gotRecs = Object.values((got.counts && got.counts.records) || {}).reduce((/** @type {number} */ n, /** @type {any} */ c) => n + Number(c), 0);
    if (gotRecs !== recs || Number(got.counts && got.counts.files) !== Number(want.files) + Number(want.chat_files || 0)) throw fail("verify_failed", "what arrived does not match the plan; nothing was removed from the old Space");
    // every file the plan named arrived with the hash it left with, checked by the puller over the bytes it received
    const hashes = got.files || {};
    for (const [p, h] of Object.entries(plan.hashes || {})) if (hashes[p] !== h) throw fail("verify_failed", `a file did not arrive intact (${p}); nothing was removed from the old Space`);
    state.verified = plan.hash;
  }
  // The project's memory room: sealed to a one-use key of the TARGET (made there, so nobody else can open it), so the courier carries only ciphertext, then imported with a receipt. Forgotten at the
  // source only after the receipt, and re-carried once if the room changed meanwhile (the same rule as a move inside one home).
  if (ports.memory && !state.memory_receipt) {
    step("memory");
    const offer = await ports.memory.offer({ target: state.pulled.target });
    const exp = await ports.memory.export({ to_key: offer.to_key });
    state.memory_receipt = await ports.memory.import({ package: exp.package, into: state.pulled.target });
  }
  // The Work engine's session lines travel in the pull itself (server to server, never through the device); its receipt is what the source forgets against.
  const knowRecords = [plan.project, ...(plan.ids || [])];
  // The source empties: the linked records and the project's files (the move's own event covers it), and the project keeps only its marker
  if (!state.emptied) {
    step("empty");
    for (const u of plan.ids || []) { const p = urnParts(u); try { const cur = await from.records.get(from.chain, p.type, p.id); if (cur && p.id !== id) await from.records.remove(from.chain, p.type, p.id); } catch { /* removed already */ } }
    /** @type {string[]} */ let left = [];
    if (typeof ports.removeFiles === "function") left = (await ports.removeFiles([...(plan.files || [])])) || [];
    else left = [...(plan.files || [])];
    if (left.length) { state.left_behind = left; } else state.emptied = true;
  }
  if (ports.know && state.pulled.know && !state.know_forgotten) {
    step("forget-know");
    try { await ports.know.forget({ records: knowRecords, receipt: state.pulled.know }); }
    catch (e) {
      // a line was written meanwhile: the target pulls the lines again (`ports.know.repull`, idempotent) and the source forgets against the new receipt, once
      if (/** @type {any} */ (e).code !== "conflict" || typeof ports.know.repull !== "function") throw e;
      state.pulled.know = await ports.know.repull({ move_id: state.move_id, records: knowRecords });
      await ports.know.forget({ records: knowRecords, receipt: state.pulled.know });
    }
    state.know_forgotten = true;
  }
  if (ports.memory && state.memory_receipt && !state.memory_forgotten) {
    step("forget-memory");
    try { await ports.memory.forget({ receipt: state.memory_receipt }); }
    catch (e) {
      if (/** @type {any} */ (e).code !== "conflict") throw e;
      const offer = await ports.memory.offer({ target: state.pulled.target });
      const exp = await ports.memory.export({ to_key: offer.to_key });
      state.memory_receipt = await ports.memory.import({ package: exp.package, into: state.pulled.target });
      await ports.memory.forget({ receipt: state.memory_receipt });
    }
    state.memory_forgotten = true;
  }
  if (!state.marked) {
    step("marker");
    const cur = await from.records.get(from.chain, type, id);
    await from.records.update(from.chain, type, id, { status: "moved", moved_to: `${to.space}:${state.pulled.target}`, repo: null, client: null, drive_path: null, memory_scope: null }, cur.version);
    state.marked = true;
  }
  if (!state.finished) {
    step("finish");
    await ports.finish("source", { move_id: state.move_id, counts: plan.counts });
    await ports.finish("target", { move_id: state.move_id, counts: plan.counts });
    state.finished = true;
  }
  step("done");
  return { target: state.pulled.target, moved: { records: plan.ids ? plan.ids.length : 0, files: plan.files ? plan.files.length : 0 }, left_behind: state.left_behind || [], not_carried: [...(ports.memory ? [] : ["the project's memory room"]), ...(state.pulled.know ? [] : ["the Work engine's session lines"])] };
}

/**
 * Upgrade a Basic Personal space to My Cloud: every project of the device in ONE approval (the lead's ruling: the person sees one prompt, not one per project). Every project is planned first; the
 * set of plan hashes is what `approveAll` asks the person to approve once (windows' batch `moves.out`: one hash over all the plans), answering a move id per project; each project then runs its own
 * move with that move id already given. Idempotent: a project already moved (its marker names where) is skipped, and one that failed resumes from its own saved state on the next run, keeping its move
 * id. Without `approveAll` (a kernel with no batch form) each project asks for its own approval through its own `runOne`.
 * @param {{ projects: any[], stateOf: (urn: string) => any, planOne: (urn: string) => Promise<any>, runOne: (plan: any, state: any) => Promise<any>, approveAll?: (plans: any[]) => Promise<Record<string, string>> }} o
 * @returns {Promise<{ moved: string[], skipped: string[], failed: { project: string, error: string }[], approved: number }>}
 */
export async function upgradePersonal({ projects, stateOf, planOne, runOne, approveAll }) {
  /** @type {string[]} */ const moved = [], skipped = [];
  /** @type {{ project: string, error: string }[]} */ const failed = [];
  /** @type {any[]} */ const todo = [];
  for (const p of projects) {
    if (p.data && p.data.status === "moved") { skipped.push(p.urn); continue; }
    try { todo.push({ urn: p.urn, plan: await planOne(p.urn) }); } catch (e) { failed.push({ project: p.urn, error: String(/** @type {Error} */ (e).message) }); }
  }
  // one approval for all of them, unless every one already holds a move id from an earlier run
  const need = todo.filter(t => !(stateOf(t.urn) || {}).move_id);
  /** @type {Record<string, string>} */ let ids = {};
  if (approveAll && need.length) {
    try { ids = (await approveAll(need.map(t => t.plan))) || {}; }
    catch (e) { for (const t of need) failed.push({ project: t.urn, error: `the approval was not given: ${/** @type {Error} */ (e).message}` }); todo.splice(0, todo.length, ...todo.filter(t => !need.includes(t))); }
  }
  for (const t of todo) {
    const st = stateOf(t.urn);
    if (ids[t.urn] && !st.move_id) st.move_id = ids[t.urn];
    try { await runOne(t.plan, st); moved.push(t.urn); } catch (e) { failed.push({ project: t.urn, error: String(/** @type {Error} */ (e).message) }); }
  }
  return { moved, skipped, failed, approved: approveAll ? need.length : 0 };
}

/**
 * The one hash a batch approval is bound to (windows' `moves.outMany`: the target, this plan hash and the sorted list of projects): the hash of the sorted per-project plan hashes, base64url, 43
 * characters. The person approves the set once; a project changing after that changes its plan hash and the set no longer matches.
 * @param {{ project: string, hash: string }[]} plans @returns {string}
 */
export const batchPlanHash = plans => crypto.createHash("sha256").update(JSON.stringify([...plans].map(p => [p.project, p.hash]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))).digest("base64url");
