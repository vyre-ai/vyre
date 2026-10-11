// @ts-check
// The lender's host (team/archive/work-journals/runner.md "runnerHost"): the runner's ports for a Space whose HOME is another computer, built on the kernel's remote call. The daemon gives this to
// `cfg.runnerHost` of the kernel handle, so `ctx.kernel.runnerHost()` answers `{ ports }` and the runner module goes from "not connected" to ready.
//   device      THIS computer's device id (core/relay/devicekey.js) and its public key: the lease and the Offer are for this computer, never a name a caller supplied
//   vault       leases.issue / renew / use over the wire; the key stays in the runner's memory
//   sync        the lent home's checkpoint store over the wire (chunked files, batched transcript)
//   grants      both Offers, from `lent.status`, cached and refreshed at most once a minute and at every renewal; when either goes the runner is told (onRevoke)
//   spec        lent.start: the Space's definition of the session with the lender's cap already applied at the home (the runner applies the cap again locally)
// Nothing here caches a secret, writes a key, or builds a chain: the home reads who is calling from the transport.
import { createLentClient } from "./lent-client.js";

/**
 * @param {{ invoke: (call: string, args: any[]) => Promise<any>, deviceId: string, deviceKey: string, eid?: string, lenderCap?: "provider" | "internet", pollMs?: number,
 *   server?: (space: string) => any, requestServer?: (space: string, session: string) => any, space?: string }} o
 */
export function createLenderHost(o) {
  let cap = o.lenderCap;   // the lender's own choice, from the Offer the person accepted at the home (lent.status), or what the daemon was given
  const client = createLentClient({ invoke: o.invoke, device: o.deviceId, deviceKey: o.deviceKey, ...(o.eid ? { eid: o.eid } : {}), cap: () => cap });
  const pollMs = Math.max(60_000, o.pollMs || 60_000);
  let state = { spaceAllows: false, memberAccepts: false };
  const told = new Set();
  let timer = null;
  const refresh = async () => {
    let next;
    try { next = await o.invoke("lent.status", [{ device_key: o.deviceKey }]); } catch { return; }   // an unreachable home changes nothing; the lease's own expiry covers a long absence
    if (!next || typeof next !== "object") return;   // an answer that is not an answer changes nothing
    cap = next.lenderCap || o.lenderCap; const was = state; state = { spaceAllows: Boolean(next.spaceAllows), memberAccepts: Boolean(next.memberAccepts) };
    if ((was.spaceAllows && !state.spaceAllows) || (was.memberAccepts && !state.memberAccepts)) for (const fn of told) { try { fn({ device: o.deviceId, reason: "withdrawn" }); } catch {} }
  };
  const ports = {
    device: o.deviceId,
    get lenderCap() { return cap; },
    vault: {
      lease: async a => { const r = await client.vault.lease(a); await refresh(); return r; },
      renew: async a => { const r = await client.vault.renew(a); await refresh(); return r; },
      credential: client.vault.credential,
    },
    sync: client.sync,
    grants: () => state,
    onRevoke: fn => { told.add(fn); if (!timer) { timer = setInterval(refresh, pollMs); timer.unref?.(); } return () => { told.delete(fn); if (!told.size && timer) { clearInterval(timer); timer = null; } }; },
    spec: client.spec, stop: client.stop, beat: client.beat, release: client.release, pipe: client.pipe, preview: client.preview, wait: client.wait, http: client.http, epochOf: client.epochOf, onFenced: client.onFenced,
    server: o.server, requestServer: o.requestServer || ((/** @type {string} */ _space, /** @type {string} */ session, /** @type {string} */ reason) => client.release({ session, reason: reason || "you" })),
  };
  // `ready` settles once the first answer is in (or the home was unreachable): await it before handing the ports to the runner, so its first `grants()` is not a guess.
  const ready = refresh();
  return { ports, ready, refresh, stop() { if (timer) clearInterval(timer); timer = null; } };
}
