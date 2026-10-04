// @ts-check
// The home's door for a paired device's Wink peer stream over the relay (the one remote path, ruling 4 Oct): a device that is the owner's opens `{ peer: "wink", space: PEER_HOME }` on its relay
// channel, and this door answers it as `device:<id>`. Two kinds of call cross, both as that device and nothing else:
//   kernel.call   a kernel call for a Space this home hosts (kernel/remote/wink.js withKernelCall: the transport proved the device, this door says which person), run by the Space's own remote server
//   any tool      a registry tool, run as the device the relay proved, with the facts the daemon's own `callerFacts` builds (the same as that device's HTTP call); the owner's presence proof, if the
//                 call has one, rides in `input.proof` and goes to the kernel as `meta.kernel_proof`, never into the tool's input
// The Noise channel proves the device, which is why a live paired session of that device stands in for the bearer token and signed request a person session otherwise needs (`sessionOf`); a device with
// no live session, or an expired or signed-out one, is its own caller with no person. `allow` is only the id's shape: the real gate is `rowOf`, asked in `accept`'s serve on every call.
// The device's row is asked of the relay on EVERY call, so a device removed after the stream opened is refused at its next call and its stream closes. Nothing here caches who a device is.
import { peerSession, streamPipe } from "../wink/node/peer-wire.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { withKernelCall } from "../../kernel/remote/wink.js";

/** The stream's `space` head: this home, not one of its hosted Spaces (a kernel call names its Space in the request). */
export const PEER_HOME = "home";
const DEVICE = /^[a-z2-7]{16}$/;
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ kernel: any, registry: any, people?: { list(): any[] } | null, now?: () => number, callerFacts: (caller: string, policy: any, via: any, k: any, capsule: boolean, device: any) => any, log?: (m: string) => void }} o
 */
export function createPeerDoor(o) {
  const log = o.log || (() => {});
  /** @type {Map<string, any>} */ const servers = new Map();
  const kernelOf = (/** @type {string} */ space) => (space === o.kernel.id.space ? o.kernel : (o.kernel.spaces && typeof o.kernel.spaces.for === "function" ? (() => { try { const h = o.kernel.spaces.for(space); return h && h.hosted === true ? h.kernel : null; } catch { return null; } })() : null));
  const serverFor = (/** @type {string} */ space) => {
    const k = kernelOf(space);
    if (!k) { servers.delete(space); return null; }
    let s = servers.get(space);
    if (!s || s.k !== k) { s = { k, server: createRemoteServer({ space, kernel: k }) }; servers.set(space, s); }
    return s.server;
  };
  /** The device's own row at the relay, now: an app device that is not removed, or null. @param {string} id */
  const rowOf = async id => { try { const r = await o.registry.call("relay.device.info", { id }, "module:vyred"); const d = r && r.data; return d && d.kind === "app" && d.removed === false ? d : null; } catch { return null; } };
  /** The person a device is: the facts the daemon proves for it (PH-1) name the home's owner, and only for a live app device. @param {string} id */
  /** The device's own live paired session (it signed in with start-paired), or null: a call is the person's with a session and a device's own, with no person, without one. @param {string} id */
  const sessionOf = id => { const now = (o.now || Date.now)(); try { const s = o.people ? o.people.list().find(x => x.node === id && x.paired && x.expires > now) : null; return s ? { id: String(s.id), kind: String(s.kind) } : null; } catch { return null; } };
  const factsOf = async (/** @type {string} */ id, /** @type {any} */ person = null) => { const row = await rowOf(id); return row ? o.callerFacts(`device:${id}`, { caller: `device:${id}`, peer: { kind: "device", stableId: id } }, person ? { person } : null, o.kernel, false, row) : null; };
  const personOf = async (/** @type {string} */ id) => { const f = await factsOf(id); return f && typeof f.person === "string" ? f.person : null; };

  const asDevice = async (/** @type {string} */ caller, /** @type {string} */ tool, /** @type {any} */ input) => {
    const id = caller.slice(7);
    const person = sessionOf(id);
    const facts = await factsOf(id, person);
    if (!facts) throw err("denied", "this device is not paired here any more");
    const body = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    /** @type {any} */ let proof;
    if (body.proof && typeof body.proof === "object") { try { if (JSON.stringify(body.proof).length <= 4096) proof = body.proof; } catch { /* no proof */ } delete body.proof; }
    // the owner's proof rides input.proof: the registry's presence floor reads it as `proof`, and the kernel as `kernel_proof` (each checks its own shape; neither is trusted here)
    const r = await o.registry.call(tool, body, caller, { ...(person ? { person } : {}), kernelFacts: facts, ...(proof ? { proof, kernel_proof: proof } : {}) });
    if (r && r.error) throw err(String(r.error.code || "internal"), String(r.error.message || "the call failed"));
    return r ? r.data : null;
  };
  const dispatch = withKernelCall(asDevice, { serverFor, personOf: (/** @type {string} */ d) => personOf(d), pathOf: () => "relay" });

  return {
    space: PEER_HOME,
    allow: (/** @type {string} */ d) => DEVICE.test(String(d)),
    /** @param {any} stream @param {{ deviceId: string }} who */
    accept(stream, who) {
      const id = who.deviceId;
      const caller = `device:${id}`;
      /** @type {any} */ let session = null;
      session = peerSession(streamPipe(stream), { first: 2, serve: async (/** @type {string} */ tool, /** @type {any} */ input) => {
        if (!DEVICE.test(id) || !(await rowOf(id))) { { const t = setTimeout(() => { try { session.close("device removed"); } catch { /* closed */ } }, 200); if (t.unref) t.unref(); } throw err("denied", "this device is not paired here any more"); }
        return dispatch(caller, tool, input);
      } });
      log(`peer door: ${caller} opened a peer stream`);
    },
  };
}
