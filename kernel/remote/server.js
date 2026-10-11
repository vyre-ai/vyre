// kernel/remote/server.js: the home's end of a remote kernel call. `serve(request, peer)` is what the transport (the Wink connection or the relay) hands the home: the
// request as JSON and the PEER the transport itself verified (the device's key and person). The Surfaces door here mints the chain from that peer, never from anything in
// the request, and runs the call on the home's own gateway, so `authorize`, the grants store and the home's sealing process (which verifies any presence proof carried in
// the arguments) decide exactly as they do for a local caller. A person who is not a member yet can reach only the join card and the accept.
// `peer.session` is set ONLY by a transport that has itself verified a presence session on that connection (a passkey sign-in on that device); nothing the device sends
// can supply it, and this server reads nothing but `peer` for who is calling.
import { KernelError } from "../core/errors.js";
import crypto from "node:crypto";
import { CALLS, INVITEE_CALLS, WIRE_VERSION, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, REPLAY_WINDOW_MS, MAX_PROOF_BYTES, CHALLENGE_TTL_MS, PRESENCE_CODES, pathOf } from "./wire.js";
import { proofRequest, PROOF_CALLS, proofNameOf } from "./proof.js";
import { canonical, sha256 } from "../core/canonical.js";
import { remoteBinding, payloadHash } from "../core/presence.js";
import { youngAt } from "../identity/chain.js";

const fail = (/** @type {any} */ id, /** @type {string} */ code, /** @type {string} */ message, /** @type {any} */ challenge = undefined) => ({ v: WIRE_VERSION, id, ok: false, error: { code, message, ...(challenge ? { challenge } : {}) } });
const MAX_STORED_BYTES = 8 * 1024 * 1024;
const INVITEE_RESPONSE_BYTES = 16 * 1024;
const RATE = Object.freeze({ member: 300, invitee: 30, window_ms: 60_000, peers: 10_000 });


/**
 * @param {{ space: string, home?: string, kernel: any, clock?: () => number, rate?: { member?: number, invitee?: number }, services?: Record<string, any>, attest?: (nonce: string) => Promise<{ pub: string, sig: string } | null>, identityEvidence?: (who: { person: string, name?: string }) => Promise<{ ops: any[], entries: { eid: string, kind: string, pub: string, founder: boolean, since: number }[] } | null> }} cfg `kernel` is the home's kernel for this Space (createKernel / bootKernel's result)
 */
export function createRemoteServer(cfg) {
  const clock = cfg.clock || Date.now;
  const k = cfg.kernel;
  const limit = { member: cfg.rate?.member ?? RATE.member, invitee: cfg.rate?.invitee ?? RATE.invitee };
  /** @type {Map<string, { at: number, bytes: number, done: boolean, p: Promise<any> }>} the calls in flight and answered, oldest first */ const seen = new Map();
  let stored = 0;
  /** @type {Map<string, { device: string, call: string, args: string, exp: number }>} the challenges issued and not yet used, by nonce */ const challenges = new Map();
  const argsHash = (/** @type {any[]} */ a) => sha256(canonical(a));
  /** What a device must sign to do this call: the call, the space, this home, a fresh one-use nonce for this device, call and arguments, and what a presence proof covers when the call has one. */
  function challengeFor(/** @type {string} */ device, /** @type {string} */ call, /** @type {any[]} */ args, /** @type {number} */ now) {
    for (const [n, c] of challenges) if (c.exp <= now) challenges.delete(n);
    // PW-3: a device holds at most 8 live challenges and evicts its own oldest, so one device asking again and again cannot invalidate another's
    const mine = [...challenges].filter(([, c]) => c.device === device);
    for (let i = 0; i <= mine.length - 8; i++) challenges.delete(mine[i][0]);
    while (challenges.size >= 4000) challenges.delete(challenges.keys().next().value);
    const nonce = crypto.randomBytes(16).toString("base64url");
    const ah = argsHash(args);
    challenges.set(nonce, { device, call, args: ah, exp: now + CHALLENGE_TTL_MS });
    // the wire names a call by its gateway path (grants.invites.create); the proof request is named by the grants call (inviteCreate)
    const short = proofNameOf(call);
    /** @type {any} */ let cover = {};
    // a reveal is covered by a proof over the reference and the purpose, under the op the sealing process checks (kernel/seal/process.js reveal)
    if (call === "seal.reveal" && args[0] && typeof args[0] === "object" && typeof args[0].ref === "string" && typeof args[0].purpose === "string") cover = { op: "seal.reveal", fields: { ref: args[0].ref, purpose: args[0].purpose }, payload_hash: payloadHash("seal.reveal", cfg.space, { ref: args[0].ref, purpose: args[0].purpose }) };
    // granting a removed computer again: the proof is the sealing process's own for `lease.reinstate`, over the member and the computer
    if (call === "leases.reinstate" && args[0] && typeof args[0] === "object" && typeof args[0].member === "string" && typeof args[0].device === "string") { const f = { member: args[0].member, device: args[0].device }; cover = { op: "lease.reinstate", fields: f, payload_hash: payloadHash("lease.reinstate", cfg.space, f) }; }
    if (short && PROOF_CALLS.includes(short)) { try { const r = proofRequest(cfg.space, short, ...args); cover = { op: r.op, fields: r.fields, payload_hash: r.payload_hash }; } catch { cover = {}; } }
    return { call, space: cfg.space, home: cfg.home || cfg.space, nonce, expires: now + CHALLENGE_TTL_MS, args_hash: ah, ...cover };
  }
  /** The nonce the device echoes: live, issued here for this device, call and arguments, and used up now whatever the kernel then says. */
  function spend(/** @type {any} */ nonce, /** @type {string} */ device, /** @type {string} */ call, /** @type {any[]} */ args, /** @type {number} */ now) {
    const c = typeof nonce === "string" ? challenges.get(nonce) : undefined;
    if (!c) return false;
    challenges.delete(String(nonce));
    return c.exp > now && c.device === device && c.call === call && c.args === argsHash(args);
  }
  /**
   * RC1, the invitee's first presence key: `grants.invites.accept` may carry `bind` in its second argument beside `seen` and `proof` ({ key_id, spki, signer, sig, attestation? }): the presence key to enrol and a signature
   * over this invite, this Space, this identity and that key by the device the invitee's hello named. The identity's signed device list comes from the names directory (`cfg.identityEvidence`), never from the caller; the
   * device the transport verified (`peer.entry`) must be on it and not young, and the signature must hold, before the sealing process enrols the key for that person, inside this same accept. Answers null when the key is
   * enrolled, else one reason code: not_listed, bad_binding, young_device, known_person, bad_invite, unavailable (or the sealing process's own refusal). Nothing is enrolled on a refusal.
   * @param {any} chain @param {any} peer @param {string} invite @param {any} bind @returns {Promise<{ code: string, message: string } | null>} null when the key is enrolled (the caller then undoes it if the accept does not finish: all or nothing)
   */
  async function joinKey(chain, peer, invite, bind) {
    const no = (/** @type {string} */ code, /** @type {string} */ message) => ({ code, message });
    if (!bind || typeof bind !== "object" || Array.isArray(bind)) return no("bad_binding", "that key binding is not usable");
    const text = (/** @type {any} */ v, /** @type {number} */ max) => typeof v === "string" && v.length > 0 && v.length <= max;
    if (!text(bind.key_id, 64) || !text(bind.spki, 400) || !text(bind.signer, 40) || !text(bind.sig, 1500) || (bind.rp !== undefined && !text(bind.rp, 253)) || (bind.attestation !== undefined && (typeof bind.attestation !== "object" || bind.attestation === null || JSON.stringify(bind.attestation).length > MAX_PROOF_BYTES))) return no("bad_binding", "that key binding is not usable");
    if (typeof k.joinKey !== "function" || typeof cfg.identityEvidence !== "function" || typeof peer.entry !== "string" || !peer.entry) return no("unavailable", "this server cannot add your device's key yet");
    // the invite must be live, unused and meant for this person before anything is enrolled
    try { const inv = await k.gateway.grants.invites.get(chain, invite); if (!inv || inv.status !== "pending") return no("bad_invite", "that invite cannot be used"); } catch { return no("bad_invite", "that invite cannot be used"); }
    /** @type {any} */ let ev = null;
    try { ev = await cfg.identityEvidence({ person: peer.person, ...(typeof peer.name === "string" && peer.name ? { name: peer.name } : {}) }); } catch { ev = null; }
    if (!ev || !Array.isArray(ev.ops) || !Array.isArray(ev.entries)) return no("unavailable", "this server could not read your identity list");
    const entry = ev.entries.find((/** @type {any} */ e) => e && e.eid === peer.entry && e.kind === "device");
    if (!entry) return no("not_listed", "this device is not on your identity list");
    // the door decides what is young itself (same rule and same clock as the sealing process); a missing time or founder flag refuses, never passes
    if (typeof entry.founder !== "boolean" || !Number.isFinite(entry.since)) return no("unavailable", "this server could not read your identity list");
    if (youngAt(entry, clock())) return no("young_device", "this sign-in is under 24 hours old; join from an older device");
    try {
      await k.joinKey({ chain, person: peer.person, ops: ev.ops, bind: { eid: peer.entry, sig: bind.sig }, invite, key_id: bind.key_id, spki: bind.spki, signer: bind.signer, ...(bind.rp ? { rp: bind.rp } : {}), ...(bind.attestation ? { attestation: bind.attestation } : {}) });
    } catch (e) {
      const code = e && typeof /** @type {any} */ (e).code === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(/** @type {any} */ (e).code) ? /** @type {any} */ (e).code : "unavailable";
      return no(code, code === "bad_binding" ? "that key binding does not check out" : code === "known_person" ? "this server already knows you: add this device with your other device" : "this server could not add your device's key");
    }
    return null;
  }
  /** @type {Map<string, number[]>} device -> the times of its recent requests */ const rate = new Map();
  // A group is the gateway's, the Surfaces door's, or a SERVICE the home registered (`cfg.services`, e.g. the lent computer's): a service group that is not registered answers no_such_call.
  const tree = (/** @type {string} */ group) => (cfg.services && Object.hasOwn(cfg.services, group) ? cfg.services[group] : group === "lent" ? undefined : group === "tasks" ? k.gateway.ask : group === "surfaces" ? k.surfaces : k.gateway[group]);
  /** Calls whose local signature is not `(chain, ...args)` or that need the home's own check before they run. */
  const ADAPT = {
    // the person's proof arrives as the trailing `{ presence }` option (checked against the home's challenge first); the gateway takes it inside the request
    "seal.reveal": () => (/** @type {any} */ chain, /** @type {any} */ i, /** @type {any} */ o) => k.gateway.seal.reveal(chain, { ...(i && typeof i === "object" ? i : {}), proof: o && typeof o === "object" ? o.presence : undefined }),
    "leases.issue": () => (/** @type {any} */ chain, /** @type {any} */ i, /** @type {any} */ o) => k.gateway.leases.issue(chain, { ...(i && typeof i === "object" ? i : {}), proof: o && typeof o === "object" ? o.presence : undefined }),
    "leases.reinstate": () => (/** @type {any} */ chain, /** @type {any} */ i, /** @type {any} */ o) => k.gateway.leases.reinstate(chain, { member: i && i.member, device: i && i.device, proof: o && typeof o === "object" ? o.presence : undefined }),
    "records.definitions": () => (/** @type {any} */ chain) => k.gateway.definitions(chain),
    "surfaces.revoke": () => (/** @type {any} */ chain, /** @type {string} */ session) => k.surfaces.revoke(session, chain),
    "surfaces.open": () => async (/** @type {any} */ chain, /** @type {any} */ o = {}) => {
      // A session may name only an assistant this Space has; the chain it yields is [person, agent], so authority is still the intersection.
      if (o && o.agent !== undefined && k.grants && !k.grants.members.has({ kind: "agent", id: String(o.agent), space: cfg.space })) throw new KernelError("not_found", "no such assistant");
      return k.surfaces.open(chain, o);
    },
  };
  const resolve = (/** @type {string} */ call) => {
    const [group, ...rest] = call.split(".");
    const name = rest.join(".");
    if (!(CALLS[/** @type {keyof typeof CALLS} */ (group)] || []).includes(name)) return null;
    if (Object.hasOwn(ADAPT, call)) return { fn: /** @type {any} */ (ADAPT)[call]() };
    let fn = tree(group);
    for (const part of name.split(".")) fn = fn && Object.hasOwn(fn, part) ? fn[part] : undefined;
    return typeof fn === "function" ? { fn } : null;
  };

  /** The chain for this peer: the Surfaces door's own, from facts the transport verified. */
  async function chainFor(/** @type {any} */ peer, /** @type {string} */ call) {
    if (!peer || typeof peer.person !== "string" || !peer.person || typeof peer.device_key_id !== "string" || !peer.device_key_id) throw new KernelError("not_a_member", "no chain for this connection");
    const path = peer.path === "wink" ? "wink" : "relay"; // anything but a Wink node is the relay: the weaker surface
    if (k.gateway.members.roleOf({ kind: "person", id: peer.person, space: cfg.space }) !== null) {
      return { member: true, chain: await k.chains.fromFacts({ kind: "device", device_key_id: peer.device_key_id, person: peer.person, path, ...(typeof peer.session === "string" && peer.session && peer.session.length <= 64 ? { session: peer.session, ...(peer.software === true ? { software: true } : {}) } : {}) }) };
    }
    if (!INVITEE_CALLS.has(call)) throw new KernelError("not_a_member", "no chain for this connection");
    return { member: false, chain: await k.chains.fromFacts({ kind: "invitee", person: peer.person, vouched: true }) };
  }

  /** One request counts against its device's window; the table of windows is bounded. */
  function overRate(/** @type {string} */ device, /** @type {boolean} */ member, /** @type {number} */ now) {
    let w = rate.get(device);
    if (!w) { if (rate.size >= RATE.peers) rate.delete(rate.keys().next().value); w = []; rate.set(device, w); }
    while (w.length && now - w[0] > RATE.window_ms) w.shift();
    if (w.length >= (member ? limit.member : limit.invitee)) return true;
    w.push(now);
    return false;
  }

  function forget(/** @type {number} */ now) {
    for (const [key, v] of seen) { if (v.done && now - v.at > REPLAY_WINDOW_MS * 2) { stored -= v.bytes; seen.delete(key); } else break; }
    while (stored > MAX_STORED_BYTES) {
      const old = [...seen].find(([, v]) => v.done);
      if (!old) break;
      stored -= old[1].bytes; seen.delete(old[0]);
    }
  }

  return Object.freeze({
    /** @param {any} request @param {{ device_key_id: string, person: string, path?: string, session?: string, entry?: string, name?: string }} peer what the transport verified (`entry` and `name`: the identity entry and claimed name an invitee's signed hello named) */
    async serve(request, peer) {
      const id = request && typeof request.id === "string" ? request.id.slice(0, 64) : null;
      try {
        if (!request || request.v !== WIRE_VERSION || typeof request.call !== "string" || !Array.isArray(request.args) || typeof id !== "string" || !id) return fail(id, "bad_input", "not a kernel call");
        if (request.space !== cfg.space) return fail(id, "not_found", "no such space here");
        if (JSON.stringify(request).length > MAX_REQUEST_BYTES) return fail(id, "too_large", "that call is too large");
        const now = clock();
        if (!(Math.abs(now - Number(request.ts)) <= REPLAY_WINDOW_MS)) return fail(id, "stale", "that call is outside its window");
        const target = resolve(request.call);
        if (!target) return fail(id, "no_such_call", "no such call");
        const who = await chainFor(peer, request.call);
        if (overRate(/^lent\.(beat|pipe|wait|http|preview)$/.test(request.call) ? `${peer.device_key_id}#${request.call.slice(5)}` : peer.device_key_id, who.member, now)) return fail(id, "rate_limited", "too many calls; wait a moment");   // a lender's heartbeat has a window of its own: a burst of file writes must never make a live computer look dead
        // A repeat of the same call from the same device, even one that arrives while the first is still running, shares the first one's answer and never runs twice;
        // another device's repeat is its own call.
        const dedupe = `${peer.device_key_id}:${id}`;
        const prior = seen.get(dedupe);
        if (prior) return await prior.p;
        const cap = who.member ? MAX_RESPONSE_BYTES : INVITEE_RESPONSE_BYTES;
        const entry = { at: now, bytes: 0, done: false, p: /** @type {Promise<any>} */ (Promise.resolve()) };
        entry.p = (async () => {
          try {
            // presence over the wire: a proof beside the args goes to the kernel as its `{ presence }` option (merged into a trailing options object, else appended) once its nonce is ours and live
            let callArgs = request.args;
            /** @type {{ person: string, invite: string, key_id: string } | null} */ let joined = null;
            const hasProof = request.proof !== undefined && request.proof !== null;
            if (hasProof) {
              let size = 0; try { size = Buffer.byteLength(JSON.stringify(request.proof)); } catch { size = Infinity; }
              if (typeof request.proof !== "object" || Array.isArray(request.proof) || size > MAX_PROOF_BYTES) return fail(id, "bad_input", "that proof is not usable");
              // RP-1: the proof must name THIS home and THIS challenge in its signed fields (`home`, `challenge`): a proof for another home, another challenge, or a local proof with neither is refused
              // before the kernel sees it, whatever its signature (the kernel's verifier checks the signature, the key, the op and its own single-use nonce).
              const bind = remoteBinding(request.proof, { home: cfg.home || cfg.space, challenge: String(request.challenge || "") });
              if (bind) { if (typeof request.challenge === "string") challenges.delete(request.challenge); return fail(id, "bad_binding", "that proof does not name this home and this challenge"); }
              if (!spend(request.challenge, peer.device_key_id, request.call, request.args, now)) return fail(id, "bad_challenge", "that proof was not made for a challenge this home issued for this call; ask again");
              // the proof is the trailing `{ presence }` option on its own, never merged into one of the caller's own arguments (PW-4)
              callArgs = [...callArgs, { presence: request.proof }];
            }
            // A joiner asks the home to prove it holds the Space: the preview's trailing `{ attest: <nonce> }` is taken off before the kernel sees it and the home's own signature over that nonce rides
            // back beside the card (never in the kernel's answer). Only on grants.invites.get, which is all an invitee may call.
            let attestNonce = null;
            if (request.call === "grants.invites.get" && callArgs.length === 2 && callArgs[1] && typeof callArgs[1] === "object" && !Array.isArray(callArgs[1]) && Object.keys(callArgs[1]).join() === "attest") {
              if (typeof callArgs[1].attest !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(callArgs[1].attest)) return fail(id, "bad_input", "that is not a nonce");
              attestNonce = callArgs[1].attest;
              callArgs = [callArgs[0]];
            }
            if (request.call === "grants.invites.accept" && !who.member && callArgs.length >= 2 && callArgs[1] && typeof callArgs[1] === "object" && !Array.isArray(callArgs[1]) && Object.hasOwn(callArgs[1], "bind")) {
              const { bind, ...rest } = callArgs[1];
              const refused = await joinKey(who.chain, peer, String(callArgs[0]), bind);
              if (refused) return fail(id, refused.code, refused.message);
              callArgs = [callArgs[0], rest, ...callArgs.slice(2)];
              joined = { person: peer.person, invite: String(callArgs[0]), key_id: bind.key_id };
            }
            let result;
            try { result = await target.fn(who.chain, ...callArgs); }
            catch (e) {
              // all or nothing: an accept that does not finish leaves no key behind (the person asks again with a fresh accept)
              if (joined && typeof k.unjoinKey === "function") { try { await k.unjoinKey({ chain: who.chain, ...joined }); } catch { /* the key stays only if the sealing process cannot be reached; it is a newcomer key for a valid invite */ } }
              throw e;
            }
            if (attestNonce && typeof cfg.attest === "function" && result && typeof result === "object") {
              let a = null; try { a = await cfg.attest(attestNonce); } catch { a = null; }
              if (a) result = { ...result, attest: a };
            }
            const out = JSON.stringify(result === undefined ? null : result);
            return out.length > cap ? fail(id, "too_large", "that answer is too large") : { v: WIRE_VERSION, id, ok: true, result: JSON.parse(out) };
          } catch (e) {
            // Only the code and the message cross; a reason the kernel kept hidden stays in the home's log.
            const err = /** @type {any} */ (e);
            const code = err && typeof err.code === "string" ? err.code : "unavailable";
            // a refused presence proof says why in the home's own log (unknown_key, wrong_decision, software_refused ...), never to the caller
            if (!PRESENCE_CODES.has(code) && err && typeof err.hidden_reason === "string" && typeof cfg.log === "function") { try { cfg.log(`kernel remote: ${request.call} on ${cfg.space} refused as ${code} (${err.hidden_reason.slice(0, 80)}) for ${peer && peer.person}`); } catch { /* a log never fails a call */ } }
            if (PRESENCE_CODES.has(code) && typeof cfg.log === "function") { try { cfg.log(`kernel remote: ${request.call} on ${cfg.space} refused as ${code} (${String((err.detail && err.detail.reason) || err.hidden_reason || "no proof or no reason given").slice(0, 80)}) for ${peer && peer.person}`); } catch { /* a log never fails a call */ } }
            return fail(id, code, err && err instanceof KernelError ? err.message : "the home could not do that", PRESENCE_CODES.has(code) && who.member ? challengeFor(peer.device_key_id, request.call, request.args, clock()) : undefined);
          }
        })();
        seen.set(dedupe, entry);
        const response = await entry.p;
        entry.done = true; entry.bytes = JSON.stringify(response).length; stored += entry.bytes;
        forget(now);
        return response;
      } catch (e) {
        const err = /** @type {any} */ (e);
        return fail(id, err && typeof err.code === "string" ? err.code : "unavailable", err && err instanceof KernelError ? err.message : "the home could not do that");
      }
    },
  });
}
export { pathOf };
