// @ts-check
// core/daemon/ownserver-host.js: the daemon's half of "a session on the person's own server is sealed at every turn" (core/runner/ownserver.js). The runner module asks `ports.ownServer`
// for two things: which transcript a finished turn belongs to (`resolve`, from the Switchboard's own record through `threads.own-transcript`) and the Space's checkpoint store (`port`),
// the same store a lent computer writes to, on this home's disk, authorized per call by the kernel as the owner's chain (checkpoint.write and checkpoint.read are held by the owner role).
import path from "node:path";
import { createCheckpointStore } from "../runner/checkpoint-store.js";
import { shareTranscript, placeTranscript } from "../spawner/client.js";

/** @param {{ kernel: any, registry: any, root: string, log?: (m: string) => void, spawnerSocket?: string }} o */
export function createOwnServerHost(o) {
  /** @type {any} */ let store = null;
  const space = () => o.kernel.id.space;
  const chain = () => o.kernel.chains.fromFacts({ kind: "device", device_key_id: "vyred-checkpoints", person: o.kernel.id.owner, path: "direct" });
  const storeOf = () => store || (store = createCheckpointStore({ space: space(), root: path.join(o.root, "checkpoints"),
    authorize: (/** @type {any} */ q) => o.kernel.gateway.authorize({ chain: q.chain, action: q.action, resource: q.resource }) }));
  return Object.freeze({
    /** A chat carried on from a person's computer, on the packaged box: the transcript is placed in the thread's account's own HOME by the spawner (whole, as the account, 0600), then made readable for the seal like any account transcript. @param {number} account @param {string} file @param {Buffer} bytes */
    place: async (account, file, bytes) => { const sock = o.spawnerSocket ? { socket: o.spawnerSocket } : {}; await placeTranscript(account, file, bytes, sock); await shareTranscript(account, file, sock); },
    /** The store's port for this home's own Space; any other Space's sessions are not this home's to seal. @param {string} s */
    port: s => { if (s !== space()) throw Object.assign(new Error("not this home's Space: give the Space this home belongs to (spaces.list shows them)"), { code: "not_found" }); return storeOf().port(chain); },
    /** @param {any} e a thread.finished event @returns {Promise<{ space: string, session: string, file: string, root: string, state: any } | null>} */
    resolve: async e => {
      const session = String((e && e.payload && (e.payload.session || e.payload.thread)) || (e && e.thread) || "");
      if (!session) return null;
      const r = /** @type {any} */ (await o.registry.call("threads.own-transcript", { session }, "module:vyred", { door: true }));
      const t = r && r.data;
      // The packaged box: the transcript is the account uid's own 0600 file; the spawner makes this one file group-readable for vyred before the seal reads it.
      if (t && process.env.VYRE_SUPERVISOR === "docker") {
        const base = path.join(process.env.VYRE_ACCOUNTS_HOME || "/home/acct") + path.sep;
        if (String(t.file).startsWith(base)) {
          const uid = Number(String(t.file).slice(base.length).split(path.sep)[0]);
          if (Number.isInteger(uid)) { try { await shareTranscript(uid, String(t.file)); } catch (err) { o.log?.(`seal: could not make ${path.basename(String(t.file))} readable for the seal: ${/** @type {Error} */ (err).message}`); return null; } }
        }
      }
      return t ? { space: space(), session: t.session, file: t.file, root: t.root, state: t.cwd ? { cwd: t.cwd } : {} } : null;
    },
  });
}
