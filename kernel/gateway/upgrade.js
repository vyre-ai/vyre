// @ts-check
// kernel/gateway/upgrade.js: upgrading a Personal space to My Cloud (the user's ruling, 5 Oct): the person's own device carries the Personal space's records, chats and memory to their server, with ONE
// approval for the whole of it, and the Personal space afterwards points to My Cloud.
//   start(chain, { to, plan_hash }, { presence })   verified ONCE in this Space's sealing process, bound to the exact target and the plan hash the person was shown (the same one-yes the project moves use);
//                                                    writes `space.upgrade_started` and answers { upgrade_id }.
//   finish(chain, { upgrade_id, counts, failed, freeze, receipt })   after the copy: writes `space.upgraded` with counts only (what moved, and the names of what did not, never their contents). With `freeze`
//                                                    this Space keeps its records readable but takes no new ones (they live in My Cloud now), but ONLY when My Cloud's own signed receipt (checked against its
//                                                    published key) says it holds exactly as many objects as this Space does, within a day of the approval. Without that proof the Space is not frozen and the answer says why.
//   movedTo()                                        the My Cloud space this one points to, or null.
// Nothing here copies a record: that is the orchestrator's (lib/spaces/upgrade.js), under the person's chains in both Spaces, through each Space's own gateway.
import { KernelError } from "../core/errors.js";
import { isChain } from "../core/chain.js";
import { mintUuid, isUuid } from "../core/ids.js";

const SPACE = /^spc_[a-z2-7]{12}$/;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const bad = (/** @type {string} */ m) => new KernelError("bad_input", m);

/**
 * @param {{ space: string, gate: (chain: any, action: string, resource: string, opts?: any) => Promise<any>, log: any, clock: () => number, sha256: (s: string) => string, canonical: (v: any) => string,
 *   countLocal?: () => Promise<number>, verifyReceipt?: (receipt: any, c: { from: string, to: string, upgrade_id: string }) => Promise<any> | any }} cfg `countLocal` counts every record this Space holds; `verifyReceipt` checks My Cloud's signed receipt against its published key
 */
export function createUpgrade(cfg) {
  const { space, gate, log, clock } = cfg;
  const person = (/** @type {any} */ chain) => { if (!isChain(chain) || chain.viewer === true || chain.hops.length !== 1 || chain.hops[0].actor.kind !== "person") throw new KernelError("chain_not_person", "only a person upgrades their own space"); return chain.hops[0].actor; };
  const events = (/** @type {string} */ type) => log.read({ type });
  /** @type {{ to: string, upgrade_id: string, at: number } | null | undefined} */ let moved;
  const readMoved = () => {
    if (moved !== undefined) return moved;
    const e = events("space.upgraded").find((/** @type {any} */ x) => x.data && x.data.freeze === true);
    moved = e ? { to: e.data.to, upgrade_id: e.data.upgrade_id, at: Number(e.time) } : null;
    return moved;
  };
  return Object.freeze({
    /** The input the approval covers (the surface builds the proof request from the same value: kernel/remote/proof.js `upgrade`). */
    inputOf: (/** @type {string} */ to, /** @type {string} */ plan_hash) => ({ to, plan_hash }),
    movedTo: () => readMoved(),
    async start(/** @type {any} */ chain, /** @type {{ to: string, plan_hash: string }} */ i, /** @type {{ presence?: any }} */ o = {}) {
      person(chain);
      if (!i || !SPACE.test(String(i.to)) || i.to === space) throw bad("name the space to upgrade to");
      if (!HASH.test(String(i.plan_hash))) throw bad("an upgrade names the plan hash the person approved");
      if (readMoved()) throw new KernelError("invalid", "this space already moved to My Cloud");
      const d = await gate(chain, "space.upgrade", `vyre://${space}/space/upgrade`, { presence: o.presence, input_hash: cfg.sha256(cfg.canonical({ action: "space.upgrade", input: { to: i.to, plan_hash: i.plan_hash } })) });
      const upgrade_id = mintUuid(clock());
      log.append(chain, { type: "space.upgrade_started", sv: 1, subject: `vyre://${space}/space/upgrade`, data: { upgrade_id, to: i.to, plan_hash: i.plan_hash } }, { decision: d.decision });
      return { upgrade_id };
    },
    async finish(/** @type {any} */ chain, /** @type {{ upgrade_id: string, counts: any, failed?: string[], freeze?: boolean, receipt?: any }} */ i) {
      const who = person(chain);
      if (!i || !isUuid(String(i.upgrade_id))) throw bad("name the upgrade");
      if (!i.counts || typeof i.counts !== "object" || Array.isArray(i.counts)) throw bad("a finished upgrade names its counts");
      const failed = Array.isArray(i.failed) ? i.failed.map(x => String(x).slice(0, 120)).slice(0, 200) : [];
      const started = events("space.upgrade_started").find((/** @type {any} */ e) => e.data && e.data.upgrade_id === i.upgrade_id);
      if (!started || typeof started.actor !== "string" || !started.actor.startsWith(`person:${who.id}@`)) throw new KernelError("not_found", "no such upgrade started here by you");
      // the upgrade may finish within a day of the approval it was given under: a live session cannot close an old approval at any later time (reviewer-3's UP-1)
      if (!(clock() - Number(started.time) <= WINDOW_MS)) throw new KernelError("invalid", "that upgrade was approved too long ago to finish; start again");
      const d = await gate(chain, "space.upgrade_finish", `vyre://${space}/space/upgrade`);
      const done = events("space.upgraded").find((/** @type {any} */ e) => e.data && e.data.upgrade_id === i.upgrade_id);
      /** @type {string | null} */ let why = null;
      let freeze = false;
      if (!done && i.freeze === true) {
        // the freeze is a closing act: it needs My Cloud's own word that everything arrived, signed with its key and covering exactly what this Space holds (reviewer-3's UP-1)
        if (!i.receipt) why = "My Cloud has not confirmed that everything arrived";
        else {
          try {
            if (typeof cfg.verifyReceipt !== "function" || typeof cfg.countLocal !== "function") throw new Error("cannot check");
            const b = await cfg.verifyReceipt(i.receipt, { from: space, to: started.data.to, upgrade_id: i.upgrade_id });
            const total = await cfg.countLocal();
            if (b && b.v === 1 && b.upgrade_id === i.upgrade_id && b.from === space && b.to === started.data.to && typeof b.objects_root === "string" && b.count === total) freeze = true;
            else why = "My Cloud's receipt does not match what this space holds";
          } catch { why = "My Cloud's receipt could not be checked"; }
        }
      }
      if (!done) {
        log.append(chain, { type: "space.upgraded", sv: 1, subject: `vyre://${space}/space/upgrade`, data: { upgrade_id: i.upgrade_id, to: started.data.to, counts: i.counts, failed, freeze, ...(freeze ? { objects_root: i.receipt.body.objects_root } : {}) } }, { decision: d.decision });
        moved = undefined;
      }
      const e = events("space.upgraded").find((/** @type {any} */ x) => x.data && x.data.upgrade_id === i.upgrade_id);
      return { upgraded: true, upgrade_id: i.upgrade_id, to: e.data.to, counts: e.data.counts, failed: e.data.failed, frozen: e.data.freeze === true, ...(why ? { not_frozen_because: why } : {}) };
    },
  });
}
