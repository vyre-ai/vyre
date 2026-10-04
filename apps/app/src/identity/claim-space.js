// @ts-check
// Make a space from a device with no box (the phone, the browser) when its home is a server: the device does the creator's half itself, as core/spaces/index.js
// claimSpace does on a daemon, in WebCrypto, with kernel/identity/chain.js and names/worker/id-messages.js themselves. Order:
//   1. `host({ name })` asks the paired server to host the space (spaces.host-here over the owner's paired peer session, with the owner's presence); it answers THE id.
//   2. The space's root PUBLIC key is made here (the record carries it and invites are fingerprinted with it). The private half is dropped when this call returns: nothing signs
//      with it for a space on a server (the record is signed by the owner's identity through any of the owner's devices, and the space's kernel holds the space's own key), so there is
//      nothing to lose with a device and nothing to keep in a browser's storage.
//   3. The space's chain (genesis, this person the first owner, acting through this device's entry) is signed with the device key and sent to the names directory
//      with the sealed record { id, name, label, rootPublic, ownerName, route, home }, signed by this device through the identity's list. Every signature is the
//      person's device key; the server signs nothing for the person.
// One function, used by the phone and the web app. If the directory refuses (name taken), nothing is claimed and `retire` (when given) takes the hosted space back.

import * as C from "../../../../kernel/identity/chain.js";
import { recordMessage } from "../../../../names/worker/id-messages.js";
import { sealRecord } from "./seal.js";

const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** @param {any} e */
function plain(e) {
  const map = /** @type {Record<string, string>} */ ({
    name_taken: "That name is taken. Pick another.", taken: "That name is taken. Pick another.", bad_name: "That is not a name Vyre can use.", reserved: "That name is reserved. Pick another.",
    rate_limited: "Too many names were claimed from here today. Try again tomorrow.", unreachable: "Cannot reach the names directory right now.",
  });
  return map[e && e.code] || (e && e.message) || "That did not work.";
}

/**
 * @param {{ identity: { id: string, name?: string | null, eid: string, ops: any[], key: import("./keys.js").DeviceKey },
 *   name: string, displayName?: string, base: string, fetch?: typeof fetch, now?: () => number, random?: (n: number) => Uint8Array,
 *   route?: { relay: string, route: string, box: string } | null, host: (a: { name: string }) => Promise<{ space: string, rootPublic?: string }>, retire?: (space: string) => Promise<any>,
 *   headers?: Record<string, string>}} o
 *   `identity.ops` is this person's own chain as the app holds it; `route` is where the paired server is reached (relay, route and box, from pairing).
 */
export async function claimServerSpace(o) {
  const now = o.now ?? Date.now, random = o.random ?? (n => crypto.getRandomValues(new Uint8Array(n)));
  const f = o.fetch ?? globalThis.fetch;
  const label = String(o.name || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(label)) throw refuse("Give the space a name.", "bad_name");
  const me = o.identity;
  if (!me || !me.id || !Array.isArray(me.ops) || !me.ops.length) throw refuse("Choose your Vyre name first.", "no_identity");
  const made = await o.host({ name: label });
  const space = made && typeof made.space === "string" ? made.space : "";
  if (!/^spc_[a-z2-7]{12}$/.test(space)) throw refuse("The server did not give the space an id. Nothing was made.", "server_refused");
  const rootPublic = made && typeof made.rootPublic === "string" ? made.rootPublic : "";
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(rootPublic)) throw refuse("This server is too old to prove it holds a space. Update it first. Nothing was made.", "server_too_old");
    const ts = now();
    const viaPos = await C.viaOf(me.ops);
    const genesis = await C.makeGenesis({
      kind: "space", entry: { eid: me.id, kind: "owner", subject: me.id, label: me.name || undefined }, nonce: C.b64u(random(12)), ts,
      via: me.eid, viaPos, sign: m => me.key.sign(m),
    });
    const ownerOps = async (/** @type {string} */ id) => (id === me.id ? me.ops : null);
    const state = await C.verifyChain([genesis], { now: ts + C.SKEW_MS, ownerOps });
    const payload = {
      v: 1, id: space, name: label, label: String(o.displayName || label).slice(0, 80), rootPublic, home: { kind: "server" },
      ...(me.name ? { ownerName: String(me.name) } : {}), ...(o.route && o.route.route ? { route: o.route } : {}),
    };
    const sealed = await sealRecord(label, payload, random);
    const sealedHash = await C.sha256hex(sealed);
    const sig = C.b64u(await me.key.sign(recordMessage({ name: label, id: state.id, by: me.id, via: me.eid, ts, sealedHash, vseq: viaPos.via_seq, vhead: viaPos.via_head })));
    const body = { name: label, ops: [genesis], sealed, rec: { by: me.id, via: me.eid, vseq: viaPos.via_seq, vhead: viaPos.via_head, ts, sig } };
    let res;
    try { res = await f(`${o.base.replace(/\/+$/, "")}/v1/ids/claim`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...(o.headers ?? {}) }, body: JSON.stringify(body) }); }
    catch { throw refuse(plain({ code: "unreachable" }), "unreachable"); }
    /** @type {any} */ let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !json || json.error || !json.data) { const e = (json && json.error) || {}; throw refuse(plain(e), String(e.code || "directory")); }
    return { space, name: `${label}.vyre.run`, label, chain: [genesis], pin: C.pinOf(state), rootPublic, claimed: json.data };
  } catch (e) {
    if (o.retire) { try { await o.retire(space); } catch { /* the server keeps an empty space; the person can retire it later */ } }
    throw e;
  }
}
