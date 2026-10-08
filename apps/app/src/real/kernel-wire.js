// @ts-check
// The app's end of a remote kernel call to a space's home (kernel/remote/wire.js, client.js): one request over a peer session's `kernel.call`, and the home's one-use presence challenge answered with the
// person's own key. The Space's kernel decides everything; nothing here is trusted but the answer. This is the part of kernel/remote/client.js an app can carry (client.js reaches node:crypto through proof.js).
//
// A call that needs the person's yes is sent bare; the home answers `presence_required` with a challenge { call, space, home, nonce, args_hash, op, fields, payload_hash }. The challenge is the home's own text, so it
// is checked against what THIS app asked before anything is signed (the call, the space, the hash of the exact arguments, and for the calls it knows, the op, fields and hash it works out itself); then the
// key signs a proof that names the home and the challenge, and the same call goes again with the proof beside it.
import { canonical, sha256 } from "../../../../kernel/core/canonical.js";
import { payloadHash } from "../../modules/vyre-signer/presence-proof.js";

const refuse = (/** @type {string} */ code, /** @type {string} */ message, /** @type {any} */ extra = {}) => Object.assign(new Error(message), { code }, extra);
const PRESENCE = new Set(["needs_presence", "presence_required"]);
const urn = (/** @type {string} */ space, /** @type {string} */ type, id = "new") => `vyre://${space}/${type}/${id}`;

/** What the person is shown and signs for the invite calls (kernel/remote/proof.js proofRequest, on the same bytes). @param {string} space @param {string} action @param {string} resource @param {any} input */
const request = (space, action, resource, input) => {
  const op = `grant.${action.split(".")[1]}`;
  const fields = { resource, input_hash: sha256(canonical({ action, input })) };
  return { op, fields, payload_hash: payloadHash(op, space, fields) };
};
/** The request a wire call is covered by, or null for a call this app does not sign. @param {string} space @param {string} call @param {any[]} args */
export function expectedRequest(space, call, args) {
  if (call === "grants.invites.create") return request(space, "grants.invite", urn(space, "invite"), args[0]);
  if (call === "grants.invites.confirm") return request(space, "grants.invite", urn(space, "invite", String(args[0])), { confirm: args[0], words: args[1] && args[1].words });
  if (call === "grants.invites.revoke") return request(space, "grants.invite", urn(space, "invite", String(args[0])), { revoke: args[0] });
  return null;
}

/**
 * @param {{ call(tool: string, input: any): Promise<any> }} peer a session to the space's home (`kernel.call` runs as the device the connection proved)
 * @param {string} space the id the home knows the space by
 * @param {{ now?: () => number, person?: string, signPresence?: (card: any) => Promise<any> }} [o] `signPresence` answers the home's challenge with the person's key; `person` is the id the proof names
 */
export function kernelWire(peer, space, o = {}) {
  const now = o.now ?? Date.now;
  let n = 0;
  const send = async (/** @type {string} */ call, /** @type {any[]} */ args, /** @type {{ proof?: any, challenge?: string }} */ extra = {}) => {
    const id = `rq_${now().toString(36)}_${(++n).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const reply = await peer.call("kernel.call", { v: 1, space, id, ts: now(), call, args, ...(extra.proof !== undefined ? { proof: extra.proof, challenge: extra.challenge } : {}) });
    if (!reply || reply.v !== 1 || reply.id !== id || typeof reply.ok !== "boolean") throw refuse("unavailable", "The home's answer was not understood.");
    if (!reply.ok) {
      const e = reply.error || {};
      throw refuse(String(e.code || "unavailable").slice(0, 40), String(e.message || "refused").slice(0, 300), e.challenge && typeof e.challenge === "object" ? { challenge: e.challenge } : {});
    }
    return reply.result;
  };
  /** The challenge is ours: for the call we made, this space, these exact arguments, and the request we work out ourselves. */
  const ours = (/** @type {any} */ ch, /** @type {string} */ call, /** @type {any[]} */ args) => {
    try {
      if (ch.call !== call || ch.space !== space || ch.args_hash !== sha256(canonical(args))) return false;
      const want = expectedRequest(space, call, args);
      if (!want) return false;
      if (ch.op !== want.op || ch.payload_hash !== want.payload_hash || canonical(ch.fields) !== canonical(want.fields)) return false;
      return typeof ch.nonce === "string" && ch.nonce.length > 0 && typeof ch.home === "string" && ch.home.length > 0;
    } catch { return false; }
  };
  return {
    /** One call by its wire path (`grants.invites.get`), the args after the chain. A call that needs the yes is answered once with this app's key. @param {string} call @param {any[]} [args] */
    async call(call, args = []) {
      const wire = JSON.parse(JSON.stringify(args.map(a => (a === undefined ? null : a))));
      try { return await send(call, wire); }
      catch (e) {
        const err = /** @type {any} */ (e);
        const ch = err && err.challenge;
        if (!(err && PRESENCE.has(err.code) && ch && typeof o.signPresence === "function" && ours(ch, call, wire))) throw e;
        const proof = await o.signPresence({ op: ch.op, space, fields: ch.fields, payload_hash: ch.payload_hash, home: ch.home, challenge: ch.nonce, person: o.person || "", prompt: PROMPT[call] || "Approve this change" });
        if (!proof || typeof proof !== "object") throw e;
        return await send(call, wire, { proof, challenge: String(ch.nonce) });
      }
    },
  };
}
const PROMPT = /** @type {Record<string, string>} */ ({ "grants.invites.create": "Invite someone to your team", "grants.invites.confirm": "Confirm the person you are inviting", "grants.invites.revoke": "Cancel an invite" });
