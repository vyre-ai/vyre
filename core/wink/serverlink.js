// @ts-check
// serverlink: this device's open Wink peer session to a server it paired, by that server's device id (`sessionFor`). One relay connection per server is kept, a peer stream
// `{ peer: "wink", space: "home" }` is opened on it when a call needs one and again after it drops, and `session.call(tool, input)` answers the tool's data or rejects with { code }.
// The server's peer door (core/daemon/peer-door.js) runs the call as THIS device and nothing else. The kernel's remote client rides it: `remoteKernel(sid, space)` is
// createRemoteKernel over winkTransport({ sessionFor }), so a kernel call is the same one path (kernel.call) as every other.
//
// `startPaired(sid)` is the device's own sign-in to the server (pair-challenge, then start-paired signed with the key the server's owner confirmed); it needs `sign`, a function that
// signs a message with that key (the app's secure key, or the daemon's), and it holds the token for the calls that carry a person session. Nothing here stores a secret.
import { peerSession, streamPipe } from "./node/peer-wire.js";
import { createRemoteKernel } from "../../kernel/remote/client.js";
import { winkTransport } from "../../kernel/remote/wink.js";
import { memoryKeyStore, webCrypto } from "../../relay/client/webcrypto.js";
import { base32 } from "../../relay/client/bytes.js";
import crypto from "node:crypto";

export const PEER_HOME = "home";
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ channelOf: (sid: string) => { relay: string, route: string, box: string } | null, connect: (o: any) => any, options?: any, name?: string,
 *   sign?: (message: string) => Promise<string> | string, presenceSigner?: (challenge: any) => Promise<{ presence: any }> | { presence: any }, proveTool?: (tool: string, input: any) => any, autoPresence?: boolean, log?: (m: string) => void, openMs?: number }} o
 *   channelOf: where the paired server is (relay, route and box, as pairing stored them); connect: the relay client's `connect`; options: its crypto and key store.
 */
export function createServerLinks(o) {
  const log = o.log || (() => {});
  /** @type {Map<string, { conn: any, peer: any, opening: Promise<any> | null, token: any, invitee?: { keyId: Promise<string> } }>} */
  const links = new Map();
  /** Where an INVITEE reaches a space's home (from the space's directory record), by the link id made for that invite. No paired server is involved. `hello` is the signed hello or a function of the channel's key id that makes one. @type {Map<string, { channel: { relay: string, route: string, box: string }, hello: any }>} */
  const invitees = new Map();
  const linkOf = (/** @type {string} */ sid) => {
    let l = links.get(sid);
    if (l) return l;
    const iv = invitees.get(sid);
    const ch = iv ? iv.channel : o.channelOf(sid);
    if (!ch) throw err("not_found", "this device has no paired server by that id");
    if (iv) {
      // An invitee's channel is its own throwaway key (no row at the box, nothing of this device's own identity on it); the key's id is what the signed hello binds, so a hello cannot be carried to another channel.
      const provider = (o.options && o.options.crypto) || webCrypto();
      const keyStore = memoryKeyStore();
      const keyId = (async () => { const k = await provider.generateKeyPair(); await keyStore.set(k); return base32(crypto.createHash("sha256").update(Buffer.from(k.publicKey)).digest()).slice(0, 16); })();
      keyId.catch(() => {});
      const ks = { get: async () => { await keyId; return keyStore.get(); }, set: (/** @type {any} */ k) => keyStore.set(k) };
      l = { conn: o.connect({ relay: ch.relay, route: ch.route, box: ch.box, name: o.name || "a device", ...(o.options || {}), crypto: provider, keyStore: ks, invitee: true }), peer: null, opening: null, token: null, invitee: { keyId } };
    } else l = { conn: o.connect({ relay: ch.relay, route: ch.route, box: ch.box, name: o.name || "a device", ...(o.options || {}) }), peer: null, opening: null, token: null };
    links.set(sid, l);
    return l;
  };
  /** The open peer session, made now when there is none. @param {string} sid */
  const openPeer = async sid => {
    const l = linkOf(sid);
    if (l.peer && !l.peer.closed) return l.peer;
    if (l.opening) return l.opening;
    l.opening = (async () => {
      // The relay client opens the channel only to the box key named by the route (the Noise handshake pins it). A box with another key never opens, so no stream head, and so no hello, is ever sent to it.
      let chan;
      try { chan = await Promise.race([l.conn.ready(), new Promise((_, rej) => { const t = setTimeout(() => rej(err("unreachable", "no answer")), o.openMs ?? 10_000); if (t.unref) t.unref(); })]); }
      catch { throw err("unreachable", l.invitee ? "that server is not the one this space names, or it cannot be reached" : "the server could not be reached"); }
      let hello = null;
      if (l.invitee) {
        const iv = invitees.get(sid);
        const made = iv && iv.hello;
        // a hello made now (a function of the channel's key id) is signed fresh for every stream, so a reconnect after the two-minute window never presents an old one
        hello = typeof made === "function" ? await made(await l.invitee.keyId) : made;
        if (!hello) throw err("not_found", "this invite has no hello to open with");
      }
      const s = chan.open({ peer: "wink", space: PEER_HOME, ...(hello ? { invitee: hello } : {}) });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { s.reset("no answer"); reject(err("unreachable", "the server did not accept the peer stream")); }, o.openMs ?? 10_000);
        s.onhead = (/** @type {any} */ h) => { clearTimeout(timer); h && h.status === 200 ? resolve(undefined) : reject(err(h && h.status === 429 ? "rate_limited" : "denied", `the server refused the peer stream (${h && h.status})`)); };
        s.onreset = (/** @type {any} */ why) => { clearTimeout(timer); reject(err("unreachable", String(why || "reset"))); };
      });
      const session = peerSession(streamPipe(s), { first: 1 });
      l.peer = session;
      return session;
    })();
    try { return await l.opening; } finally { l.opening = null; }
  };

  /** @type {Map<string, number[]>} */ const stamps = new Map();
  const signIns = (/** @type {string} */ sid) => { const now = Date.now(); const a = (stamps.get(sid) || []).filter(t => now - t < 60_000); if (a.length >= 3) { stamps.set(sid, a); return false; } a.push(now); stamps.set(sid, a); return true; };
  /**
   * A call the server answers `presence_required` is signed by THIS device's own presence key over the tool and its input and sent once more with the proof in `input.proof`: the same proof shape a local
   * act carries, made here and checked by the home. The server never signs for the person, and a device with no key of its own just gets the refusal.
   * @param {any} session @param {string} tool @param {any} input @param {any} opt
   */
  async function callWithPresence(session, tool, input, opt) {
    try { return await session.call(tool, input, opt); }
    catch (e) {
      // PW-1: a key that needs no person never signs a presence challenge on its own: the automatic signer exists only on a development build behind the dev switch (it is the software signer)
      if (!(e && e.code === "presence_required") || o.autoPresence !== true || typeof o.proveTool !== "function" || (input && input.proof !== undefined)) throw e;
      const { proof: _p, ...bare } = input && typeof input === "object" ? input : {};
      return session.call(tool, { ...bare, proof: o.proveTool(tool, bare) }, opt);
    }
  }

  /** @param {string} sid */
  const sessionFor = sid => {
    linkOf(sid); // not_found now, not at the first call
    return Object.freeze({
      /** @param {string} tool @param {any} [input] @param {any} [opt] */
      async call(tool, input = {}, opt = {}) {
        let session = await openPeer(sid);
        // A call that needs the person and finds no live paired session (never started, or lapsed) signs this device in once and goes again: nobody signs in by hand. A refused grant answers the server's own reason.
        // PW-5: a sign-in is triggered by the error CODE, never by matching a server's text, and at most 3 times a minute per server
        const needsPerson = (/** @type {any} */ e) => e && e.code === "person_session_required" && signIns(sid);
        try {
          try { return await callWithPresence(session, tool, input, opt); }
          catch (e) {
            if (!needsPerson(e) || typeof o.sign !== "function") throw e;
            try { await startPaired(sid); } catch (se) { throw Object.assign(new Error(`this device could not sign in to the server: ${/** @type {Error} */ (se).message}`), { code: /** @type {any} */ (se).code || "denied" }); }
            return await callWithPresence(session, tool, input, opt);
          }
        }
        catch (e) {
          // a stream that dropped between calls is made again once; a refusal from the server is the answer
          if (/** @type {any} */ (e).code === "unreachable" && (!session || session.closed)) { session = await openPeer(sid); return session.call(tool, input, opt); }
          throw e;
        }
      },
      close() { const l = links.get(sid); if (l && l.peer) { try { l.peer.close("done"); } catch { /* closed */ } l.peer = null; } },
    });
  };

  /** A tool call on the server's own HTTP surface over this link (the sign-in tools, which a paired device calls before it holds a session). @param {any} l */
  const postOn = l => async (/** @type {string} */ tool, /** @type {any} */ body) => {
    const r = await l.conn.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (r.status >= 300 || !j || j.error) throw err(String((j && j.error && j.error.code) || "denied"), String((j && j.error && j.error.message) || `the server answered ${r.status}`));
    return j.data;
  };
  /** Ask the owner's PHONE for the yes one of the three moments needs, for a device that cannot sign it itself (a browser): the card goes into the approvals queue (core/approvals): `{ moment: "pair" | "vault" | "outward", request: { op, fields } }` -> { id, expires_in_s, line }. Poll `approvalStatus`; when `approved` the act spends the approval once. @param {string} sid @param {{ moment: string, request: any }} card */
  const askApproval = async (sid, card) => sessionFor(sid).call("approvals.ask", { moment: String(card && card.moment), request: card && card.request });
  /** @param {string} sid @param {string} id @returns {Promise<{ state: "waiting" | "approved" | "refused" | "none", approval?: string }>} */
  const approvalStatus = async (sid, id) => sessionFor(sid).call("approvals.status", { id });

  /** This device's sign-in to the server: pair-challenge, then start-paired with the key the server's owner confirmed. Holds the token. @param {string} sid */
  const startPaired = async sid => {
    if (typeof o.sign !== "function") throw err("unavailable", "this device has no key to sign in with");
    const l = linkOf(sid);
    const post = postOn(l);
    const ch = await post("presence.person.pair-challenge", {});
    const device = String((l.conn.reply && l.conn.reply.device) || "");
    const message = `paired-start\n${device}\n${ch.challenge}`;
    const sig = await o.sign(message);
    // a device whose identity entry has an enclave (or keystore) key signs the same message with it too: the server then marks this session enclave-strength (a device key copied off the phone cannot)
    const esig = typeof o.signEnclave === "function" ? await Promise.resolve(o.signEnclave(message)).catch(() => null) : null;
    const t = await post("presence.person.start-paired", { sig, ...(esig ? { esig: String(esig) } : {}), ...(o.name ? { label: o.name } : {}) });
    l.token = t;
    return { id: t.id, expires: t.expires };
  };

  /**
   * A session for a person who is NOT a member yet, to the home named by a space's directory record. `hello` is signed by the spaces module (the invitee's identity key over
   * the box, space and invite); it rides in the stream head and the door admits grants.invites.get and grants.invites.accept only. A new hello (a new invite, or the same one
   * signed again) replaces the old link, so an expired hello is never reused.
   * @param {{ relay: string, route: string, box: string }} channel @param {any} hello a signed hello, or `(channelKeyId) => hello` (then pass `{ invite }` third)
   */
  const inviteeSessionFor = function (/** @type {any} */ channel, /** @type {any} */ hello, /** @type {{ invite?: string } | undefined} */ about) {
    const invite = typeof hello === "function" ? about && about.invite : hello && hello.invite;
    if (!channel || !channel.route || !hello || typeof invite !== "string") throw err("bad_input", "an invitee session needs a route, an invite and a signed hello");
    const sid = `invitee:${channel.route}:${invite}`;
    invitees.set(sid, { channel, hello });
    return sessionFor(sid);
  };

  return {
    sessionFor,
    inviteeSessionFor,
    startPaired,
    askApproval,
    approvalStatus,
    /** A kernel for one Space the server hosts, over the same peer session: the kernel's own remote client. @param {string} sid @param {string} space */
    remoteKernel: (sid, space) => createRemoteKernel({ space, transport: winkTransport({ sessionFor: () => sessionFor(sid) }), ...(o.presenceSigner ? { signer: o.presenceSigner } : {}) }),
    token: (/** @type {string} */ sid) => (links.get(sid) ? links.get(sid)?.token : null),
    close() { for (const l of links.values()) { try { l.peer && l.peer.close("done"); } catch { /* closed */ } try { l.conn.close(); } catch { /* closed */ } } links.clear(); },
  };
}
