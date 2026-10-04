// @ts-check
// core/daemon/ownserver-host.js: the daemon's half of "a session on the person's own server is sealed at every turn" (core/runner/ownserver.js). The runner module asks `ports.ownServer`
// for two things: which transcript a finished turn belongs to (`resolve`, from the Switchboard's own record through `threads.own-transcript`) and the Space's checkpoint store (`port`),
// the same store a lent computer writes to, on this home's disk, authorized per call by the kernel as the owner's chain (checkpoint.write and checkpoint.read are held by the owner role).
import path from "node:path";
import { createCheckpointStore } from "../runner/checkpoint-store.js";

/** @param {{ kernel: any, registry: any, root: string, log?: (m: string) => void }} o */
export function createOwnServerHost(o) {
  /** @type {any} */ let store = null;
  const space = () => o.kernel.id.space;
  const chain = () => o.kernel.chains.fromFacts({ kind: "device", device_key_id: "vyred-checkpoints", person: o.kernel.id.owner, path: "direct" });
  const storeOf = () => store || (store = createCheckpointStore({ space: space(), root: path.join(o.root, "checkpoints"),
    authorize: (/** @type {any} */ q) => o.kernel.gateway.authorize({ chain: q.chain, action: q.action, resource: q.resource }) }));
  return Object.freeze({
    /** The store's port for this home's own Space; any other Space's sessions are not this home's to seal. @param {string} s */
    port: s => { if (s !== space()) throw Object.assign(new Error("not this home's Space"), { code: "not_found" }); return storeOf().port(chain); },
    /** @param {any} e a thread.finished event @returns {Promise<{ space: string, session: string, file: string, root: string, state: any } | null>} */
    resolve: async e => {
      const session = String((e && e.payload && (e.payload.session || e.payload.thread)) || (e && e.thread) || "");
      if (!session) return null;
      const r = /** @type {any} */ (await o.registry.call("threads.own-transcript", { session }, "module:vyred", { door: true }));
      const t = r && r.data;
      return t ? { space: space(), session: t.session, file: t.file, root: t.root, state: t.cwd ? { cwd: t.cwd } : {} } : null;
    },
  });
}
