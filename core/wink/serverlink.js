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

export const PEER_HOME = "home";
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ channelOf: (sid: string) => { relay: string, route: string, box: string } | null, connect: (o: any) => any, options?: any, name?: string,
 *   sign?: (message: string) => Promise<string> | string, presenceSigner?: (challenge: any) => Promise<{ presence: any }> | { presence: any }, proveTool?: (tool: string, input: any) => any, autoPresence?: boolean, log?: (m: string) => void, openMs?: number }} o
 *   channelOf: where the paired server is (relay, route and box, as pairing stored them); connect: the relay client's `connect`; options: its crypto and key store.
 */
export function createServerLinks(o) {
  const log = o.log || (() => {});
  /** @type {Map<string, { conn: any, peer: any, opening: Promise<any> | null, token: any, hello?: any }>} */
  const links = new Map();
  /** Where an INVITEE reaches a space's home (from the space's directory record), by the link id made for that invite. No paired server is involved. @type {Map<string, { channel: { relay: string, route: string, box: string }, hello: any }>} */
  const invitees = new Map();
  const linkOf = (/** @type {string} */ sid) => {
    let l = links.get(sid);
    if (l) return l;
    const iv = invitees.get(sid);
    const ch = iv ? iv.channel : o.channelOf(sid);
    if (!ch) throw err("not_found", "this device has no paired server by that id");
    l = { conn: o.connect({ relay: ch.relay, route: ch.route, box: ch.box, name: o.name || "a device", ...(o.options || {}) }), peer: null, opening: null, token: null, ...(iv ? { hello: iv.hello } : {}) };
    links.set(sid, l);
    return l;
  };
  /** The open peer session, made now when there is none. @param {string} sid */
  const openPeer = async sid => {
    const l = linkOf(sid);
    if (l.peer && !l.peer.closed) return l.peer;
    if (l.opening) return l.opening;
    l.opening = (async () => {
      const chan = await l.conn.ready();
      const s = chan.open({ peer: "wink", space: PEER_HOME, ...(l.hello ? { invitee: l.hello } : {}) });
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
  /** Ask the server's owner to let this device sign in from their phone (a device whose own key is software, such as a browser): { id, expires_in_s }. Then poll `signInStatus`, and on `approved` call `startPaired`: that session has the phone's strength. @param {string} sid @param {string} [label] */
  const askSignIn = async (sid, label) => postOn(linkOf(sid))("presence.person.session-ask", label ? { label } : {});
  /** @param {string} sid @param {string} id @returns {Promise<{ state: "waiting" | "approved" | "refused" | "none" | "timeout" }>} */
  const signInStatus = async (sid, id) => postOn(linkOf(sid))("presence.person.session-status", { id });

  /** This device's sign-in to the server: pair-challenge, then start-paired with the key the server's owner confirmed. Holds the token. @param {string} sid */
  const startPaired = async sid => {
    if (typeof o.sign !== "function") throw err("unavailable", "this device has no key to sign in with");
    const l = linkOf(sid);
    const post = postOn(l);
    const ch = await post("presence.person.pair-challenge", {});
    const device = String((l.conn.reply && l.conn.reply.device) || "");
    const sig = await o.sign(`paired-start\n${device}\n${ch.challenge}`);
    const t = await post("presence.person.start-paired", { sig, ...(o.name ? { label: o.name } : {}) });
    l.token = t;
    return { id: t.id, expires: t.expires };
  };

  /**
   * A session for a person who is NOT a member yet, to the home named by a space's directory record. `hello` is signed by the spaces module (the invitee's identity key over
   * the box, space and invite); it rides in the stream head and the door admits grants.invites.get and grants.invites.accept only. A new hello (a new invite, or the same one
   * signed again) replaces the old link, so an expired hello is never reused.
   * @param {{ relay: string, route: string, box: string }} channel @param {any} hello
   */
  const inviteeSessionFor = (channel, hello) => {
    if (!channel || !channel.route || !hello || typeof hello.invite !== "string") throw err("bad_input", "an invitee session needs a route and a signed hello");
    const sid = `invitee:${channel.route}:${hello.invite}`;
    const old = links.get(sid);
    if (old && old.hello && old.hello.nonce !== hello.nonce) { try { old.peer && old.peer.close("done"); } catch { /* closed */ } try { old.conn.close(); } catch { /* closed */ } links.delete(sid); }
    invitees.set(sid, { channel, hello });
    return sessionFor(sid);
  };

  return {
    sessionFor,
    inviteeSessionFor,
    startPaired,
    askSignIn,
    signInStatus,
    /** A kernel for one Space the server hosts, over the same peer session: the kernel's own remote client. @param {string} sid @param {string} space */
    remoteKernel: (sid, space) => createRemoteKernel({ space, transport: winkTransport({ sessionFor: () => sessionFor(sid) }), ...(o.presenceSigner ? { signer: o.presenceSigner } : {}) }),
    token: (/** @type {string} */ sid) => (links.get(sid) ? links.get(sid)?.token : null),
    close() { for (const l of links.values()) { try { l.peer && l.peer.close("done"); } catch { /* closed */ } try { l.conn.close(); } catch { /* closed */ } } links.clear(); },
  };
}
