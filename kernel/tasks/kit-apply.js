// kernel/tasks/kit-apply.js: the owner's approval of a Kit's install card IS the presence for that install, and for nothing else (the lead's ruling, 5 Oct).
// The approval proof signs the task with its `form_hash` (kernel/tasks: the form is in the body the proof covers), and the form names the Kit by `kit_hash`. Applying the approved Kit
// begins here: the kernel checks the task (approved by a person, done, within a day, not applied before), that the Kit it is handed hashes to the one the form names, and that the chain
// applying it is the approver's own and carries no assistant. Then, EVENT FIRST (`kit.applying`, which also makes the approval spent for good, across restarts), it hands back a waiver:
// an object only this module makes, good for a couple of minutes, for the chain it was made for, and for exactly the types the Kit lists, each once. `records.define` accepts it as the
// admin presence it would otherwise ask the person for, only for a diff made of those types, byte for byte. Nothing here is a reusable presence token.
import { canonical, sha256 } from "../core/canonical.js";
import { isChain, chainHash } from "../core/chain.js";
import { KernelError } from "../core/errors.js";
import { mintUuid } from "../core/ids.js";

const MAX_AGE_MS = 24 * 3600_000, WAIVER_LIFE_MS = 120_000;
const WAIVED = new Set(["records.define"]);
/** The chain as the waiver binds it: every hop with how it entered (surface, device, session), and the job it runs for: another chain of the same person is another chain. */
const actorsOf = (/** @type {any} */ chain) => `${chainHash(chain)}|${JSON.stringify(chain.job || null)}`;

/**
 * @param {{ space: string, tasks: { kitApproval(id: string): any }, log: any, chains: any, clock?: () => number, types?: () => Promise<readonly { name: string }[]> }} cfg
 */
export function createKitApply(cfg) {
  const clock = cfg.clock || Date.now;
  /** @type {Set<string>} tasks whose approval was spent on an install (read back from the log at start, so a restart does not make it new again) */ const used = new Set();
  try { for (const e of cfg.log.read({ type: "kit.applying" })) if (e && e.data && typeof e.data.task === "string") used.add(e.data.task); } catch { /* an empty log */ }
  /** @type {Map<string, number>} resumes made per task (an install that stopped after `kit.applying` may be resumed again and again: one approval, one content) */ const resumed = new Map();
  try { for (const e of cfg.log.read({ type: "kit.resumed" })) if (e && e.data && typeof e.data.task === "string") resumed.set(e.data.task, Math.max(resumed.get(e.data.task) || 0, Number(e.data.attempt) || 1)); } catch { /* an empty log */ }
  /** @type {Set<string>} tasks whose install is complete (`kit.installed` is in the log) */ const installed = new Set();
  try { for (const e of cfg.log.read({ type: "kit.installed" })) if (e && e.data && typeof e.data.task === "string") installed.add(e.data.task); } catch { /* an empty log */ }
  const kitChain = () => cfg.chains.fromFacts({ kind: "module", module: "kits", first_party: true });
  /** @param {string} task @param {any} extra */
  const markInstalled = (task, extra) => { if (installed.has(task)) return; cfg.log.append(kitChain(), { type: "kit.installed", sv: 1, subject: `vyre://${cfg.space}/kit/${task}`, data: { task, ...extra }, vis: "owner", red: "internal" }); installed.add(task); };
  /** @type {WeakMap<object, { task: string, chain: string, types: Map<string, string>, expires: number }>} */ const live = new WeakMap();
  const bad = (/** @type {string} */ why) => new KernelError("not_allowed", why);

  /** Everything an install needs to be true, short of being unused. @param {{ chain: any, task: string, kit: any }} i */
  function check(i) {
    const { chain, task, kit } = i || /** @type {any} */ ({});
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    if (chain.hops.some((/** @type {any} */ h) => h.actor.kind === "agent")) throw bad("an assistant proposes a Kit; it never applies one");
    if (typeof task !== "string" || !kit || typeof kit !== "object" || !Array.isArray(kit.types)) throw new KernelError("bad_input", "name the approved task and the Kit it approved");
    const a = cfg.tasks.kitApproval(task);
    if (!a) throw bad("that task is not an approved Kit install");
    if (!a.form || a.form.kind !== "kit_install" || typeof a.form.kit_hash !== "string") throw bad("that task's form does not name a Kit");
    if (sha256(canonical(a.form)) !== (a.payload && a.payload.form_hash)) throw bad("the approval does not cover this form");
    if (sha256(canonical(kit)) !== a.form.kit_hash) throw bad("this Kit is not the one that was approved");
    if (clock() - a.at > MAX_AGE_MS) throw bad("that approval is older than a day");
    const approver = a.approver && a.approver.hops && a.approver.hops[0] && a.approver.hops[0].actor;
    const mine = chain.hops.find((/** @type {any} */ h) => h.actor.kind === "person");
    if (!approver || !mine || mine.actor.id !== approver.id) throw bad("only the person who approved it applies it");
    return { a, mine, task, kit };
  }
  /** A waiver for exactly these types, for this chain. @param {string} task @param {any} chain @param {any[]} types */
  function mint(task, chain, types) {
    const waiver = Object.freeze({ id: `kw_${mintUuid(clock())}` });
    live.set(waiver, { task, chain: actorsOf(chain), types: new Map(types.map((/** @type {any} */ t) => [String(t && t.name), canonical(t)])), expires: clock() + WAIVER_LIFE_MS });
    return waiver;
  }

  return Object.freeze({
    /**
     * @param {{ chain: any, task: string, kit: { types?: any[] } & Record<string, any> }} i
     * @returns {Promise<object>} the waiver
     */
    async begin(i) {
      const { a, mine, task, kit } = check(i);
      if (used.has(task)) throw bad("that approval has been used");
      // Event first: once this line is in the log the approval is spent, whatever happens next.
      cfg.log.append(cfg.chains.fromFacts({ kind: "module", module: "kits", first_party: true }), { type: "kit.applying", sv: 1, subject: `vyre://${cfg.space}/kit/${String(task)}`, data: { task, kit_hash: a.form.kit_hash, by: mine.actor.id }, vis: "owner", red: "internal" });
      used.add(task);
      if (!kit.types.length) markInstalled(task, { attempt: 0 });
      return mint(task, i.chain, kit.types);
    },
    /**
     * Finish an install that stopped (a crash after `kit.applying`, or a define that failed). Repeatable: as often as it takes, with the one approval, within a day of it, by the approver's own
     * chain, for a task whose `kit.applying` is in the log, for the Kit that was approved (its content must still hash to the approved `kit_hash`), and only for the Kit's types that are not
     * defined yet; an updated type is never resumed (an update is a new approval). `kit.resumed` (with the attempt number) is written first; `kit.installed` when nothing is missing; a resume with
     * nothing missing defines nothing and answers `{ already_installed: true }`.
     * @param {{ chain: any, task: string, kit: { types?: any[] } & Record<string, any> }} i
     */
    async resume(i) {
      const { a, mine, task, kit } = check(i);
      if (!used.has(task)) throw bad("that approval was never applied; begin it");
      let have;
      try { have = new Set(typeof cfg.types === "function" ? (await cfg.types()).map(t => t.name) : []); } catch { throw new KernelError("unavailable", "the types could not be listed"); }
      const missing = kit.types.filter((/** @type {any} */ t) => !have.has(String(t && t.name)));
      // Nothing missing: the Kit is installed. No waiver, nothing defined; the answer says so (and the record of it is written if it is not there yet).
      if (!missing.length) { markInstalled(task, { attempt: resumed.get(task) || 0 }); return Object.freeze({ already_installed: true }); }
      const attempt = (resumed.get(task) || 0) + 1;
      cfg.log.append(kitChain(), { type: "kit.resumed", sv: 1, subject: `vyre://${cfg.space}/kit/${String(task)}`, data: { task, kit_hash: a.form.kit_hash, by: mine.actor.id, attempt, types: missing.map((/** @type {any} */ t) => String(t.name)) }, vis: "owner", red: "internal" });
      resumed.set(task, attempt);
      return mint(task, i.chain, missing);
    },
    /**
     * Does this waiver cover exactly this definition by this chain? A type may be defined once under it, and only as the Kit lists it; anything else in the diff refuses the whole call.
     * @param {object} waiver @param {any} chain @param {any} diff
     */
    coversDefine(waiver, chain, diff) {
      const s = live.get(waiver);
      if (!s || s.expires < clock() || !isChain(chain) || actorsOf(chain) !== s.chain) return false;
      if (!diff || typeof diff !== "object" || Object.keys(diff).some(k => k !== "add_types" && k !== "change_types")) return false;
      const types = [...(diff.add_types || []), ...(diff.change_types || [])];
      if (!types.length || types.some(t => !t || s.types.get(String(t.name)) !== canonical(t))) return false;
      return true;
    },
    /** The define went through: those types are spent under this waiver (a refused define strands nothing). @param {object} waiver @param {any} diff */
    spend(waiver, diff) {
      const s = live.get(waiver);
      if (!s) return;
      for (const t of [...(diff.add_types || []), ...(diff.change_types || [])]) s.types.delete(String(t.name));
      if (!s.types.size) markInstalled(s.task, { attempt: resumed.get(s.task) || 0 });
    },
    /** What `authorize` asks for the presence it would otherwise need: a live waiver, for this chain and one of the waived actions. @param {any} waiver @param {{ chain: any, action: string }} q */
    waives(waiver, q) {
      const s = waiver && typeof waiver === "object" ? live.get(waiver) : undefined;
      return Boolean(s && s.expires >= clock() && WAIVED.has(q.action) && isChain(q.chain) && actorsOf(q.chain) === s.chain);
    },
    /** The install is done (or given up): the waiver is no good any more. @param {object} waiver */
    end(waiver) { live.delete(waiver); },
  });
}
