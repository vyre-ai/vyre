// @ts-check
// The home's door for a paired device's Wink peer stream over the relay (the one remote path, ruling 4 Oct): a device that is the owner's opens `{ peer: "wink", space: PEER_HOME }` on its relay
// channel, and this door answers it as `device:<id>`. Two kinds of call cross, both as that device and nothing else:
//   kernel.call   a kernel call for a Space this home hosts (kernel/remote/wink.js withKernelCall: the transport proved the device, this door says which person), run by the Space's own remote server
//   any tool      a registry tool, run as the device the relay proved, with the facts the daemon's own `callerFacts` builds (the same as that device's HTTP call); the owner's presence proof, if the
//                 call has one, rides in `input.proof` and goes to the kernel as `meta.kernel_proof`, never into the tool's input
// The Noise channel proves the device, which is why a live paired session of that device stands in for the bearer token and signed request a person session otherwise needs (`sessionOf`); a device with
// no live session, or an expired or signed-out one, is its own caller with no person. `allow` is only the id's shape: the real gate is `rowOf`, asked in `accept`'s serve on every call.
// The device's row is asked of the relay on EVERY call, so a device removed after the stream opened is refused at its next call and its stream closes. Nothing here caches who a device is.
import { zoneFrom } from "../../lib/time/index.js";
import { peerSession, streamPipe, T } from "../wink/node/peer-wire.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { withKernelCall, KERNEL_CALL_TOOL } from "../../kernel/remote/wink.js";
import { INVITEE_CALLS, WIRE_VERSION, PRESENCE_CODES } from "../../kernel/remote/wire.js";
import { youngAt } from "../../kernel/identity/chain.js";
import { verifyDevice } from "../wink/node/peer-wire.js";
import crypto from "node:crypto";
import { deviceIdOf } from "../../lib/caller.js";

/** The stream's `space` head: this home, not one of its hosted Spaces (a kernel call names its Space in the request). */
export const PEER_HOME = "home";
const DEVICE = /^[a-z2-7]{16}$/;
/** Streams over the peer wire: caps and the frame size. */
export const STREAM_LIMITS = Object.freeze({ perDevice: 8, frameBytes: 15_000, queuedBytes: 1_000_000, checkMs: 5_000, framesPerSecond: 200 });
const STREAM_ID = /^[A-Za-z0-9_-]{8,64}$/;
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ kernel: any, registry: any, people?: { list(): any[] } | null, events?: { on(type: string, f: (e: any) => void): (() => void) | void } | null, now?: () => number, identityEntry?: (identity: string, eid: string, name?: string) => Promise<{ pub: string, alg?: string, held?: string, since?: number, founder?: boolean } | null>, boxId?: () => Promise<string | null>, isServer?: (id: string) => boolean, lent?: (space: string, kernel: any) => any, onSession?: (caller: string, session: any) => void, serverFor?: (space: string) => { serve(request: any, peer: any): Promise<any> } | null, memberWatchMs?: number, inviteeLimits?: { perInvite?: number, perIdentity?: number, perMinute?: number, perChannel?: number, perBox?: number, nonceMax?: number, idleMs?: number, presenceMs?: number }, callerFacts: (caller: string, policy: any, via: any, k: any, capsule: boolean, device: any) => any, log?: (m: string) => void }} o
 */
export function createPeerDoor(o) {
  const log = o.log || (() => {});
  /** @type {Map<string, any>} */ const servers = new Map();
  const kernelOf = (/** @type {string} */ space) => (space === o.kernel.id.space ? o.kernel : (o.kernel.spaces && typeof o.kernel.spaces.for === "function" ? (() => { try { const h = o.kernel.spaces.for(space); return h && h.hosted === true ? h.kernel : null; } catch { return null; } })() : null));
  const serverFor = (/** @type {string} */ space) => {
    if (typeof o.serverFor === "function") return o.serverFor(space);
    const k = kernelOf(space);
    if (!k) { servers.delete(space); return null; }
    let s = servers.get(space);
    if (!s || s.k !== k) { s = { k, server: createRemoteServer({ space, home: o.kernel.id.space, kernel: k, log, ...(o.lent ? (() => { const l = (() => { try { return o.lent(space, k); } catch { return null; } })(); if (l) log(`peer door: the lent-computer service is up for ${space}`); return l ? { services: { lent: l } } : {}; })() : {}), identityEvidence: async (/** @type {{ person: string, name?: string }} */ w) => { try { const r = await o.registry.call("spaces.identity.evidence", w, "module:vyred", { door: true }); return r && !r.error && r.data && Array.isArray(r.data.ops) ? r.data : null; } catch { return null; } }, attest: async nonce => { const r = await o.registry.call("spaces.attest", { space, nonce }, "module:vyred"); return r && r.data && !r.error ? r.data : null; } }) }; servers.set(space, s); }
    return s.server;
  };
  /** The device's own row at the relay, now: an app device that is not removed, or null. @param {string} id */
  /** What a paired SERVER (a Wink device of kind server, not a relay app device) may ask its home on the direct door: the network's own read-only status, nothing else. A server belongs to an identity but never speaks for it. */
  const SERVER_TOOLS = new Set(["network.wink.status", "network.wink.whois"]);
  const rowOf = async id => {
    try {
      const r = await o.registry.call("relay.device.info", { id }, "module:vyred"); const d = r && r.data;
      if (!(d && d.kind === "app" && d.removed === false)) return null;
      // the person the device's own record names (Wink: who confirmed it); callerFacts gives the device the owner's person only when this is the home's owner
      let person = null; try { const w = await o.registry.call("wink.device.record", { id }, "module:vyred"); person = w && w.data && typeof w.data.owner === "string" ? w.data.owner : null; } catch { person = null; }
      return { ...d, person };
    } catch { return null; }
  };
  /** The person a device is: the facts the daemon proves for it (PH-1) name the home's owner, and only for a live app device. @param {string} id */
  /** The device's own live paired session (it signed in with start-paired), or null: a call is the person's with a session and a device's own, with no person, without one. @param {string} id */
  const sessionOf = id => { const now = (o.now || Date.now)(); try { const s = o.people ? o.people.list().find(x => x.node === id && x.paired && x.expires > now) : null; return s ? { id: String(s.id), kind: String(s.kind), ...(s.software ? { software: true } : {}) } : null; } catch { return null; } };
  const factsOf = async (/** @type {string} */ id, /** @type {any} */ person = null) => { const row = await rowOf(id); return row ? o.callerFacts(`device:${id}`, { caller: `device:${id}`, peer: { kind: "device", stableId: id } }, person ? { person } : null, o.kernel, false, row) : null; };
  const personOf = async (/** @type {string} */ id) => { const f = await factsOf(id); return f && typeof f.person === "string" ? f.person : null; };

  const asDevice = async (/** @type {string} */ caller, /** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ peerStream = null, /** @type {any} */ wire = null) => {
    const id = caller.slice(7);
    const person = sessionOf(id);
    const facts = await factsOf(id, person);
    if (!facts) throw err("denied", "this device is not paired here any more");
    const body = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    // an approval id (a card the owner's phone answered) rides beside the call, never into the tool's input
    const approval = typeof body.approval === "string" ? body.approval : undefined;
    if (!(tool && o.registry.tools && o.registry.tools.get(tool) && o.registry.tools.get(tool).input && o.registry.tools.get(tool).input.properties && Object.hasOwn(o.registry.tools.get(tool).input.properties, "approval"))) delete body.approval;
    /** @type {any} */ let proof;
    // PD-1: a tool that takes `proof` as a parameter of its own (a pairing's identity proof) keeps it in its input and gets nothing in meta; for any other tool `proof` is the owner's presence proof
    const declared = (() => { try { const t = o.registry.tools && o.registry.tools.get(tool); return Boolean(t && t.input && t.input.properties && Object.hasOwn(t.input.properties, "proof")); } catch { return false; } })();
    if (!declared && body.proof && typeof body.proof === "object") { try { if (JSON.stringify(body.proof).length <= 4096) proof = body.proof; } catch { /* no proof */ } delete body.proof; }
    // the owner's proof rides input.proof: the registry's presence floor reads it as `proof`, and the kernel as `kernel_proof` (each checks its own shape; neither is trusted here)
    const r = await o.registry.call(tool, body, caller, { ...(wire && typeof wire.zone === "string" && zoneFrom(wire.zone, "") ? { zone: zoneFrom(wire.zone, "") } : {}), ...(person ? { person } : {}), ...(peerStream ? { peerStream } : {}), kernelFacts: facts, ...(proof ? { proof, kernel_proof: proof } : {}), ...(approval ? { approval } : {}) });
    if (r && r.error) throw Object.assign(err(String(r.error.code || "internal"), String(r.error.message || "the call failed")), r.error.detail ? { detail: r.error.detail } : {});
    return r ? r.data : null;
  };

  // ---- the invitee door (lead, 4 Oct: DESIGN-spaces-first.md "How a second person reaches a space to join it") ----
  // A person who is not a member of a space opens `{ peer: "wink", space: "home", invitee: { space, invite, identity, entry, name?, ts, nonce, sig } }` on a relay channel that said `invitee` in its hello
  // (it made no device row). The door admits it only when ALL of these hold: the hello is fresh (2 minutes) and its nonce is new; the identity's entry resolves from the names directory and its signature over this
  // box's own id, the space, the invite, the identity, the entry, the time, the nonce and the channel's own key id checks out (so a hello cannot be replayed at another box); the space is one this home hosts; and the space's kernel
  // shows the invite as unexpired and unused, and, if it is addressed to one identity, to this one. What the stream may then do is `grants.invites.get` and `grants.invites.accept` for THAT invite, nothing else:
  // no registry tool, no other kernel call, no person session. A wrong, spent or other-identity token closes the stream. Accepting ends it. Rates are held per invite and per identity (counted only for a hello whose signature verified, so naming someone cannot lock them out), per channel, and per box for directory lookups, with a miss remembered for a minute.
  const HELLO_WINDOW_MS = 120_000;
  const MISS_MAX = 2000, MISS_MS = 60_000;
  /** @type {Map<string, number>} nonce -> expiry (insertion order is expiry order, so the oldest is always first) */ const nonces = new Map();
  /** @type {Map<string, number[]>} */ const uses = new Map();
  /** @type {Map<string, number>} "identity/entry/name" -> when the directory last had no such entry (negative cache) */ const misses = new Map();
  /** @type {number[]} when the directory was last asked on behalf of any invitee channel (the box-wide cap) */ let lookups = [];
  const lim = { perInvite: 30, perIdentity: 60, perMinute: 60_000, perBox: 120, nonceMax: 5000, idleMs: 30_000, presenceMs: 120_000, perChannel: /** @type {number | undefined} */ (undefined), ...(o.inviteeLimits || {}) };
  const perChannel = lim.perChannel ?? lim.perIdentity;
  const over = (/** @type {string} */ key, /** @type {number} */ max, /** @type {number} */ now) => {
    const a = (uses.get(key) || []).filter(t => now - t < lim.perMinute);
    uses.set(key, a);
    if (a.length >= max) return true;
    a.push(now);
    if (uses.size > 5000) for (const [k, v] of uses) if (!v.length || now - v[v.length - 1] > lim.perMinute) uses.delete(k);
    return false;
  };
  /** Drops the oldest entries of an insertion-ordered map until it holds at most `max`. @param {Map<any, any>} m @param {number} max */
  const trim = (m, max) => { while (m.size > max) { const k = m.keys().next().value; m.delete(k); } };
  // The signed hello names the box, the space, the invite, the identity, its entry, the time, the nonce and the channel's own key id, so it cannot be replayed at another box or carried onto another channel
  const helloMessage = (/** @type {string} */ box, /** @type {any} */ h) => Buffer.from(`vyre-invitee-hello-v2\n${box}\n${h.space}\n${h.invite}\n${h.identity}\n${h.entry}\n${h.ts}\n${h.nonce}\n${h.channel}`, "utf8");
  /**
   * Checks one invitee hello and says why not, or answers { identity }. The order is the defence: shape and freshness cost nothing; the directory is asked only inside a box-wide cap and never twice for
   * an entry it just said it did not know; the signature is checked next; and only a hello that VERIFIED is counted against its invite and its identity, so nobody can use up a victim's allowance
   * by naming them. A channel's own allowance is its own key's, so spending it hurts no one else. @param {any} h @param {string} inviteeId
   */
  const checkHello = async (h, inviteeId) => {
    const now = (o.now || Date.now)();
    if (!h || typeof h !== "object" || Array.isArray(h)) return { why: "bad_input" };
    const str = (/** @type {any} */ v, /** @type {RegExp} */ re) => typeof v === "string" && re.test(v);
    if (!str(h.space, /^spc_[a-z2-7]{12,26}$/) || !str(h.invite, /^(inv_[0-9a-f]{32}|member)$/) || !str(h.identity, /^per_[a-z2-7]{26}$/) || !str(h.entry, /^[a-z2-7]{26}$/) || !str(h.nonce, /^[A-Za-z0-9_-]{16,64}$/) || !str(h.channel, /^[a-z2-7]{16}$/) || !Number.isFinite(h.ts) || !str(h.sig, /^[A-Za-z0-9_-]{80,100}$/)) return { why: "bad_input" };
    if (h.name !== undefined && !str(h.name, /^[a-z0-9.-]{3,253}$/)) return { why: "bad_input" };
    if (h.channel !== inviteeId) return { why: "wrong_channel" };
    if (Math.abs(now - Number(h.ts)) > HELLO_WINDOW_MS) return { why: "stale" };
    for (const [n, exp] of nonces) { if (exp > now) break; nonces.delete(n); }
    if (nonces.has(h.nonce)) return { why: "replayed" };
    if (over(`d:${inviteeId}`, perChannel, now)) return { why: "rate_limited" };
    if (typeof o.identityEntry !== "function" || typeof o.boxId !== "function") return { why: "cannot_check" };
    let box = null;
    try { box = await o.boxId(); } catch { box = null; }
    if (!box) return { why: "cannot_check" };
    const missKey = `${h.identity}/${h.entry}/${h.name || ""}`;
    const missed = misses.get(missKey);
    if (missed !== undefined && now - missed < MISS_MS) return { why: "unknown_identity" };
    lookups = lookups.filter(t => now - t < lim.perMinute);
    if (lookups.length >= lim.perBox) return { why: "rate_limited" };
    lookups.push(now);
    /** @type {any} */ let entry = null;
    try { entry = await o.identityEntry(h.identity, h.entry, h.name); } catch { return { why: "cannot_check" }; }
    if (!entry || typeof entry.pub !== "string" || entry.alg === "webauthn-es256" || entry.held === "web") { misses.delete(missKey); misses.set(missKey, now); trim(misses, MISS_MAX); return { why: "unknown_identity" }; }
    if (!verifyDevice(entry.pub, helloMessage(box, h), h.sig)) return { why: "bad_proof" };
    // a member's device is held to the same newcomer rule as everywhere else: under 24 hours on the identity's list it reaches nothing, unless it founded the list (an entry whose age is unknown is young)
    if (h.invite === "member" && (typeof entry.founder !== "boolean" || !Number.isFinite(entry.since) || youngAt({ founder: entry.founder, since: /** @type {number} */ (entry.since) }, now))) return { why: "young_device" };
    if (over(h.invite === "member" ? `m:${h.space}:${h.identity}` : `i:${h.invite}`, lim.perInvite, now) || over(`p:${h.identity}`, lim.perIdentity, now)) return { why: "rate_limited" };
    if (nonces.has(h.nonce)) return { why: "replayed" };
    nonces.set(h.nonce, now + 2 * HELLO_WINDOW_MS);
    trim(nonces, lim.nonceMax);
    return { identity: h.identity, pub: entry.pub };
  };
  /** A kernel request for one of the two invitee calls on this invite, as the invitee. @param {string} space @param {string} call @param {any[]} args @param {number} now */
  const inviteeRequest = (space, call, args, now) => ({ v: WIRE_VERSION, space, id: `inv-${crypto.randomBytes(8).toString("hex")}`, ts: now, call, args });
  const dispatchFor = (/** @type {any} */ peerStream) => withKernelCall((/** @type {string} */ c, /** @type {string} */ t, /** @type {any} */ i, /** @type {any} */ x) => asDevice(c, t, i, peerStream, x), { serverFor, personOf: (/** @type {string} */ d) => personOf(d), pathOf: () => "relay" });
  /** @type {Map<string, number>} device -> its open streams, across its peer streams */
  const openByDevice = new Map();
  /** @type {Set<{ id: string, check: () => void }>} the accepted peer streams with streams open, re-checked when a device is removed or a session ends (PS-C: an event, not a fast poll) */
  const watchers = new Set();
  if (o.events && typeof o.events.on === "function") for (const type of ["device.removed", "wink.removed", "presence.signed-out", "presence.refused"]) { try { o.events.on(type, () => { for (const w of [...watchers]) w.check(); }); } catch { /* no bus */ } }

  const door = {
    space: PEER_HOME,
    allow: (/** @type {string} */ d) => DEVICE.test(String(d)),
    /**
     * The direct path's dispatcher (core/wink/netd.js, node host serveHome): the same call a relay stream makes, for a device that has just proved its identity-list key at the node door.
     * The device's relay row is read on every call, so a removed device is refused at its next call; the kernel's chain records the path as "wink".
     * @param {string} caller @param {string} tool @param {any} input
     */
    serve: async (caller, tool, input) => {
      const id = deviceIdOf(String(caller || "")) || "";
      if (!id) throw err("denied", "this device is not paired here any more");
      if (!(DEVICE.test(id) && (await rowOf(id)))) {
        // not an app device: a live paired server of this home may read the network's status (its direct-door key was checked at the node door), and nothing else
        if (!(/^[A-Za-z0-9_-]{1,64}$/.test(id) && typeof o.isServer === "function" && o.isServer(id))) throw err("denied", "this device is not paired here any more");
        if (!SERVER_TOOLS.has(String(tool))) throw err("denied", "a paired server may only read the network's status on its home");
        // a server's id is not a device-class label (lib/caller.js), and it must not become one: the two reads run as the daemon, on this server's behalf, and nothing else does
        const r = await o.registry.call(tool, input && typeof input === "object" ? input : {}, "module:vyred", { door: true, onBehalfOf: caller });
        if (r && r.error) throw Object.assign(err(String(r.error.code || "internal"), String(r.error.message || "the call failed")), r.error.detail ? { detail: r.error.detail } : {});
        return r ? r.data : null;
      }
      return withKernelCall((/** @type {string} */ c, /** @type {string} */ t, /** @type {any} */ i, /** @type {any} */ x) => asDevice(c, t, i, null, x), { serverFor, personOf: (/** @type {string} */ d) => personOf(d), pathOf: () => "wink" })(caller, tool, input);
    },
    /**
     * An invitee's stream (see above). `head` is the hello the peer stream carried. @param {any} stream @param {{ inviteeId: string }} who @param {any} head
     */
    acceptInvitee(stream, who, head) {
      const inviteeId = String(who.inviteeId);
      /** @type {any} */ let session = null;
      /** @type {any} */ let idleTimer = null;
      const end = (/** @type {string} */ why) => { if (idleTimer) clearTimeout(idleTimer); if (watcher) clearInterval(watcher); const t = setTimeout(() => { try { session && session.close(why); } catch { /* closed */ } }, 50); if (t.unref) t.unref(); };
      /** @type {Promise<{ ok: true, identity: string, space: string, invite: string } | { ok: false, why: string }> | null} */ let admitted = null;
      const admit = () => admitted || (admitted = (async () => {
        const c = await checkHello(head, inviteeId);
        if (!c.identity) { log(`peer door: invitee ${inviteeId} refused (${String(c.why)})`); return { ok: false, why: String(c.why) }; }
        const server = serverFor(head.space);
        if (!server) { log(`peer door: invitee ${inviteeId} refused (not_found)`); return { ok: false, why: "not_found" }; }
        // A MEMBER's stream (the hello names `member` where an invitee's names its invite): the person joined this space before and reaches it from a device on their own identity list. The space's own kernel decides whether they
        // are a member (its member read answers only for one); from then on the stream carries kernel calls under the member's own chain, which the home builds from this channel's proved facts like any member device's.
        if (head.invite === "member") {
          const m = await server.serve(inviteeRequest(head.space, "grants.members.get", [c.identity], (o.now || Date.now)()), { device_key_id: inviteeId, person: c.identity, path: "relay" });
          if (!m || m.ok !== true || !m.result) { log(`peer door: member ${inviteeId} refused (not_a_member${m && m.error ? `: ${String(m.error.code)}` : ""})`); return { ok: false, why: "not_a_member" }; }
          return { ok: true, member: true, pub: c.pub, identity: c.identity, space: head.space, invite: "member", entry: head.entry, ...(typeof head.name === "string" && head.name ? { name: head.name } : {}) };
        }
        // the space's own kernel decides whether this invite is live, unused and meant for this person: a preview is the proof (it is all the invitee may read before it accepts)
        const r = await server.serve(inviteeRequest(head.space, "grants.invites.get", [head.invite], (o.now || Date.now)()), { device_key_id: inviteeId, person: c.identity, path: "relay" });
        if (!r || r.ok !== true || !r.result || r.result.status !== "pending") { log(`peer door: invitee ${inviteeId} refused (bad_invite${r && r.error ? `: ${String(r.error.code)}` : ""})`); return { ok: false, why: "bad_invite" }; }
        return { ok: true, identity: c.identity, space: head.space, invite: head.invite, entry: head.entry, ...(typeof head.name === "string" && head.name ? { name: head.name } : {}) };
      })());
      /** Is a member's stream still entitled: the device's entry is on its identity's list now (read live, same key as admitted) and the space's kernel still shows the person as a member. @param {any} a */
      const memberStillOk = async a => {
        try {
          const e = typeof o.identityEntry === "function" ? await o.identityEntry(a.identity, a.entry, a.name) : null;
          if (!e || typeof e.pub !== "string" || e.pub !== a.pub || e.alg === "webauthn-es256" || e.held === "web") return false;
          const sv = serverFor(a.space);
          if (!sv) return false;
          const m = await sv.serve(inviteeRequest(a.space, "grants.members.get", [a.identity], (o.now || Date.now)()), { device_key_id: inviteeId, person: a.identity, path: "relay" });
          return Boolean(m && m.ok === true && m.result);
        } catch { return false; }
      };
      // accepting (or a refusal of the invite itself) finishes the stream at once: no call after it is served, even inside the moment the close takes
      let finished = false;
      // a stream with no call either way for 30 s is closed (IV-5: silent streams must not hold the invitee pool); while the home waits for the invitee's presence answer it may be silent for 2 minutes
      const arm = (/** @type {number} */ ms) => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => { finished = true; end("idle"); }, ms); if (idleTimer.unref) idleTimer.unref(); };
      arm(lim.idleMs);
      let wait = lim.idleMs;
      // an open member stream is re-checked on its own too (a removal is not waited for until the next call): the device or the membership gone ends it
      const watchMs = o.memberWatchMs ?? 10_000;
      /** @type {any} */ let watcher = null;
      if (head && head.invite === "member") admit().then(a => {
        if (!a.ok || a.member !== true || finished) return;
        watcher = setInterval(async () => { if (finished) { clearInterval(watcher); return; } if (!(await memberStillOk(a))) { finished = true; clearInterval(watcher); end("not a member any more"); } }, watchMs);
        if (watcher.unref) watcher.unref();
      }, () => {});
      const handle = async (/** @type {string} */ tool, /** @type {any} */ input) => {
        const a = await admit();
        if (!a.ok) { finished = true; end("not admitted"); throw err("denied", "that invite cannot be used from here"); }
        if (tool !== KERNEL_CALL_TOOL || !input || typeof input !== "object") throw err("denied", "an invite opens two calls and nothing else");
        if (a.member === true) {
          // a member's stream: the space's kernel calls and nothing else (no registry tool, no other space); the invite calls are not a member's
          if (input.space !== a.space || INVITEE_CALLS.has(String(input.call))) throw err("denied", "a member stream opens this space's kernel calls and nothing else");
          // every call: the device must still be on the identity's signed list (the same key it was admitted with) and the person must still be a member; otherwise the stream ends now
          if (!(await memberStillOk(a))) { finished = true; end("not a member any more"); throw err("denied", "this device or this membership is gone"); }
          const sv = serverFor(a.space);
          if (!sv) { end("gone"); throw err("not_found", "no such space here"); }
          return sv.serve(input, { device_key_id: inviteeId, person: a.identity, path: "relay", entry: a.entry });
        }
        const args = Array.isArray(input.args) ? input.args : [];
        if (input.space !== a.space || !INVITEE_CALLS.has(String(input.call)) || args[0] !== a.invite) throw err("denied", "an invite opens two calls and nothing else");
        const server = serverFor(a.space);
        if (!server) { end("gone"); throw err("not_found", "no such space here"); }
        const r = await server.serve(input, { device_key_id: inviteeId, person: a.identity, path: "relay", entry: a.entry, ...(a.name ? { name: a.name } : {}) });
        // accepting ends the stream (a member session begins elsewhere); so does any refusal of the invite itself. The home asking for the invitee's presence is not a refusal: the same stream carries the signed retry.
        const asksPresence = Boolean(r && r.ok !== true && r.error && PRESENCE_CODES.has(String(r.error.code)));
        if (!asksPresence && (input.call === "grants.invites.accept" || !r || r.ok !== true)) { finished = true; end("done"); }
        if (asksPresence) wait = lim.presenceMs;
        return r;
      };
      session = peerSession(streamPipe(stream), { first: 2, serve: async (/** @type {string} */ tool, /** @type {any} */ input) => {
        if (finished) throw err("denied", "this invite's stream is finished");
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        wait = lim.idleMs;
        try { return await handle(tool, input); } finally { if (!finished) arm(wait); }
      } });
      log(`peer door: invitee ${inviteeId} opened a stream`);
    },
    /** @param {any} stream @param {{ deviceId: string }} who */
    accept(stream, who) {
      const id = who.deviceId;
      const caller = `device:${id}`;
      const pipe = streamPipe(stream);
      /** @type {any} */ let session = null;
      // ---- streams over this peer stream: a call opens one (`meta.peerStream.open`), its frames travel as server-to-device messages, the device may close its own, and a dropped peer stream ends them all ----
      /** @type {Map<string, { seq: number, cleanup: (() => void) | null }>} */
      const open = new Map();
      let rowOk = true, timer = /** @type {any} */ (null);
      const live = () => rowOk && sessionOf(id) !== null;
      const send = (/** @type {number} */ type, /** @type {any} */ body) => { try { session.sendControl(type, body); } catch { /* closed */ } };
      const finishStream = (/** @type {string} */ sid, /** @type {string} */ why, /** @type {boolean} */ tell) => {
        const st = open.get(sid);
        if (!st) return;
        open.delete(sid);
        openByDevice.set(id, Math.max(0, (openByDevice.get(id) || 1) - 1));
        if (tell) send(T.streamEnd, { id: sid, why });
        try { if (st.cleanup) st.cleanup(); } catch { /* the producer must not break the door */ }
        if (!open.size) { watchers.delete(watcher); if (timer) { clearInterval(timer); timer = null; } }
      };
      const endAll = (/** @type {string} */ why, /** @type {boolean} */ tell) => { for (const sid of [...open.keys()]) finishStream(sid, why, tell); };
      const check = () => { rowOf(id).then(r => { rowOk = Boolean(r); if (!live()) endAll("session_ended", true); }, () => { rowOk = false; endAll("session_ended", true); }); };
      const watcher = { id, check };
      // an event re-checks at once; the slow timer (5 s) only covers a build whose bus does not say
      const watch = () => {
        watchers.add(watcher);
        if (timer) return;
        timer = setInterval(check, STREAM_LIMITS.checkMs);
        if (timer.unref) timer.unref();
      };
      const peerStream = Object.freeze({
        /**
         * @param {string} sid the stream's id (the caller's, unguessable) @param {(h: { emit: (data: any) => boolean, end: (why?: string) => void, alive: () => boolean }) => (() => void) | void} producer
         */
        open(sid, producer) {
          if (typeof sid !== "string" || !STREAM_ID.test(sid)) throw err("bad_input", "a stream id is 8 to 64 letters, digits, - and _");
          if (open.has(sid)) throw err("conflict", "that stream is already open");
          if ((openByDevice.get(id) || 0) >= STREAM_LIMITS.perDevice) throw err("rate_limited", "this device has too many streams open");
          if (!live()) throw err("denied", "this device has no live paired session");
          const st = { seq: 0, cleanup: /** @type {(() => void) | null} */ (null), win: /** @type {number[]} */ ([]) };
          open.set(sid, st);
          openByDevice.set(id, (openByDevice.get(id) || 0) + 1);
          watch();
          const emit = (/** @type {any} */ data) => {
            if (!open.has(sid)) return false;
            if (!live()) { finishStream(sid, "session_ended", true); return false; }   // no frame after the session ends
            let text; try { text = JSON.stringify({ id: sid, seq: st.seq + 1, data }); } catch { finishStream(sid, "bad_frame", true); return false; }
            if (Buffer.byteLength(text) > STREAM_LIMITS.frameBytes) { finishStream(sid, "too_large", true); return false; }
            if (pipe.buffered() > STREAM_LIMITS.queuedBytes) { finishStream(sid, "slow", true); return false; }
            // PS-D: a stream may not flood the peer stream its calls share: more than framesPerSecond in any second ends it
            const nowMs = Date.now();
            while (st.win.length && nowMs - st.win[0] > 1000) st.win.shift();
            if (st.win.length >= STREAM_LIMITS.framesPerSecond) { finishStream(sid, "slow", true); return false; }
            st.win.push(nowMs);
            st.seq += 1;
            send(T.stream, { id: sid, seq: st.seq, data });
            return true;
          };
          /** @type {any} */ let cleanup;
          try { cleanup = producer({ emit, end: (why = "done") => finishStream(sid, String(why).slice(0, 40), true), alive: () => open.has(sid) && live() }); }
          catch (e) { finishStream(sid, "failed", false); throw e; }
          if (typeof cleanup === "function") { if (open.has(sid)) st.cleanup = cleanup; else { try { cleanup(); } catch { /* gone */ } } }
          return { id: sid };
        },
      });
      const dispatch = dispatchFor(peerStream);
      session = peerSession(pipe, { first: 2,
        serve: async (/** @type {string} */ tool, /** @type {any} */ input) => {
          if (!DEVICE.test(id) || !(await rowOf(id))) { { const t = setTimeout(() => { try { session.close("device removed"); } catch { /* closed */ } }, 200); if (t.unref) t.unref(); } throw err("denied", "this device is not paired here any more"); }
          return dispatch(caller, tool, input);
        },
        // the device closes a stream it opened (an id it never opened is ignored: it cannot touch another's)
        onframe: (/** @type {{ type: number, payload: Buffer }} */ f) => {
          if (f.type !== T.streamEnd) return false;
          try { const j = JSON.parse(f.payload.toString("utf8")); if (j && typeof j.id === "string") finishStream(j.id, "client", false); } catch { /* not a frame */ }
          return true;
        } });
      session.onclose = () => { endAll("closed", false); watchers.delete(watcher); };
      // the admitted device's session, two-way: the home calls back down it (a storage drive that only that device can reach is held this way, core/wink/storage/hold.js)
      if (o.onSession) { try { o.onSession(caller, session); } catch (e) { log(`peer door: onSession failed (${String(/** @type {any} */ (e).message).slice(0, 80)})`); } }
      log(`peer door: ${caller} opened a peer stream`);
    },
  };
  // The server door over the relay: the same restricted read as the direct door's, for a paired server whose direct path is down. The server's row is asked on every call (isServer), so a
  // removed server is refused at its next call and its stream closes; what it may ask is exactly SERVER_TOOLS, run as the daemon on its behalf.
  door.isServer = (/** @type {string} */ id) => typeof o.isServer === "function" && o.isServer(String(id)) === true;
  door.acceptServer = (/** @type {any} */ stream, /** @type {{ serverId: string }} */ who) => {
    const id = String(who.serverId);
    /** @type {any} */ let session = null;
    session = peerSession(streamPipe(stream), { first: 2, serve: async (/** @type {string} */ tool, /** @type {any} */ input) => {
      if (!door.isServer(id)) { const t = setTimeout(() => { try { session.close("device removed"); } catch { /* closed */ } }, 200); if (t.unref) t.unref(); throw err("denied", "this server is not paired here any more"); }
      return door.serve(`device:${id}`, tool, input);
    } });
    log(`peer door: server ${id} opened a peer stream through the relay`);
  };
  return door;
}
