// @ts-check
// presence, the module: the keys a person proves presence with (docs/adr/0004-presence.md).
//
// The verifier itself lives in index.js and vyred builds it before any module starts, so the
// registry can ask it about every call. This module is the user's handle on it: list the enrolled
// Capsule keys, device keys and passkeys, enroll or remove one, and mint a one-time code for enrolling a
// passkey from the Deck. Enrolling, removing and minting need presence themselves; they are on
// the floor's list, and they say so here too.

import crypto from "node:crypto";
import { devSwitch } from "../../kernel/devbuild.js";
import { STRENGTHS } from "./strengths.js";
import { Presence } from "./index.js";
import { PersonSessions } from "./person.js";
import { isServer } from "../config/index.js";

// A paired phone reaches presence.person.start-paired, pair-challenge and rotate over its relay or tailnet channel: only those labels, never a model, a guest or MCP.
const RELAY_DEVICE_CALLERS = Object.freeze(["tailnet", "relay", "device"]);
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    // Rows only: challenges and nonces live in vyred's own verifier, not in this one.
    // `softwareOk`: a development-kind build behind VYRE_SEAL_SOFTWARE takes a device key as presence (marked software); a release-kind one never does (PW-1), and a device key opens no session there (PS-1).
    const presence = new Presence({ db: ctx.store.db, log: m => ctx.log(m), softwareOk: () => devSwitch(process.env.VYRE_SEAL_SOFTWARE) });

    ctx.tool("presence.keys", {
      effect: "read", callers: ["cli", "local", "deck", "capsule", "tailnet", "device", "module"], // key names and ids are the person's, not a model's
      description: "The Capsule keys, device keys and passkeys enrolled for proving presence: id, kind, name, when enrolled and last used. Never the keys themselves.",
      input: obj({}),
      // On a Mac with vyre-core, the list is core's (a read vyred may proxy, ADR 0040 section 3).
      run: async () => (presence.coreLink ? presence.coreLink.keys() : presence.keys()),
    });

    ctx.tool("presence.enroll", {
      effect: "write",
      // Listed, not defaulted: the relay enrolls a paired device's key from its listener, where no person is the original caller, so the registry's origin check on a defaulted tool would hide it.
      // The presence floor still needs a proof from every caller but a first-party module, and a device's passkey is enrolled by module:relay only (checked in the body).
      callers: ["cli", "local", "deck", "capsule", "tailnet", "device", "space", "agent", "module"],
      description: "Enroll a Capsule key (P-256 in the Secure Enclave, alg -7), a device key (P-256 with alg -7, or RSA of 2048 bits or more with alg -257, as Windows Hello makes) or a passkey, by its public key as base64url SPKI DER, a JWK or a Windows BCRYPT RSA blob. Needs presence.",
      presence: { summary: async input => `Enroll a ${input.kind === "passkey" ? "passkey" : input.kind === "device" ? "device key" : "Capsule key"} named "${String(input.name || input.kind)}"` },
      input: obj({ kind: { type: "string", enum: ["capsule", "passkey", "device"] }, name: str, public_key: str, alg: { type: "integer" }, rp_id: str, credential_id: str,
        device: str },
        ["kind", "public_key"]),
      run: async (input, meta = {}) => {
        // A passkey a browser made at relay pairing (ADR 0032 part 2b): only the relay module enrolls
        // one, for the device it just paired, under an allowed app's name (app.vyre.run). It proves
        // only for that device, from that origin.
        if (input.device !== undefined) {
          if (meta.caller !== "module:relay") throw Object.assign(new Error("only the relay enrolls a device's passkey"), { code: "denied" });
          if (input.kind !== "passkey" || !/^[a-z2-7]{16}$/.test(String(input.device))) throw Object.assign(new Error("a device's key here is a passkey for a relay device id"), { code: "bad_input" });
          const origins = ((ctx.config.network || {}).origins || ["https://app.vyre.run"]).map(String);
          const origin = origins.find(o => { try { return new URL(o).hostname === String(input.rp_id || "").toLowerCase(); } catch { return false; } });
          if (!origin) throw Object.assign(new Error(`a device's passkey must be for an allowed app (${origins.join(", ")})`), { code: "denied" });
          const k = presence.enroll({ ...input, origin });
          ctx.events.emit("presence.enrolled", { id: k.id, kind: k.kind, name: k.name });
          return k;
        }
        // On the box a passkey must belong to the Deck's own address, not a name in the request.
        if (isServer(ctx.config.machine) && input.kind === "passkey") {
          let host = null;
          try { host = new URL(String((ctx.config.network || {}).address || "")).hostname; } catch {}
          if (!host) throw new Error("the box has no address yet, so no passkey can be enrolled");
          if (String(input.rp_id || "").toLowerCase() !== host.toLowerCase()) throw new Error(`a passkey here must be for ${host}`);
        }
        const k = presence.enroll(input);
        ctx.events.emit("presence.enrolled", { id: k.id, kind: k.kind, name: k.name });
        return k;
      },
    });

    ctx.tool("presence.remove", {
      effect: "write",
      // Listed, not defaulted, like presence.enroll: the relay takes a device's presence key away when the device goes (a removal, the end of a setup session) from its own code, where no person is the
      // original caller, so the registry's origin check on a defaulted tool refused it and the key stayed enrolled after its device was gone. A person still needs the presence proof.
      callers: ["cli", "local", "deck", "capsule", "tailnet", "device", "space", "agent", "module"],
      description: "Remove an enrolled Capsule key, device key or passkey by id. Needs presence.",
      presence: { summary: async input => `Remove the presence key ${String(input.id)}` },
      input: obj({ id: str }, ["id"]),
      run: async ({ id }) => {
        if (!presence.remove(id)) throw new Error(`no key ${id}`);
        ctx.events.emit("presence.removed", { id });
        return { removed: id };
      },
    });

    ctx.tool("presence.capsule.pin", {
      effect: "write",
      description: "Pins the Capsule build `vyre capsule install` just signed, so vyred can tell that real build apart from anything else with its own ambiguous, tty-less process shape (its own proof, not ancestry: core/daemon/peer.js's verifiedCapsule). Signed by the Capsule's own enrolled presence key (method \"capsule\"), the same identity a paired Capsule already proves with, not a new one -- so only the real Capsule, not a model's shell with a same-uid file write, can ever set this.",
      presence: { summary: async () => "Pin this Mac's Capsule build" },
      input: obj({ cdhash: str }, ["cdhash"]),
      run: async ({ cdhash }, meta = {}) => {
        // presence:{} above accepts any of touchid/passkey/device/capsule (whichever methods
        // this Mac has enrolled); narrowed here to exactly the identity this claim is ABOUT --
        // the Capsule proving it is itself, not the person separately vouching for it by some
        // other means, which would prove nothing about which binary is asking.
        if (meta.presence?.method !== "capsule") throw Object.assign(new Error("only the Capsule's own enrolled key pins a Capsule build"), { code: "denied" });
        // The calling binary's own signature, read by vyred from the socket (core/daemon), never
        // from the input. An ad-hoc build has no signing identity, so a same-uid program could
        // pass as it: refused until the Capsule is signed with a stable identity (the lead's
        // decision, 28 Sep).
        const sig = meta.codeSignature;
        if (!sig || !sig.cdhash) throw Object.assign(new Error("Vyre could not read this Capsule's code signature, so it cannot pin it. Pin from the Capsule app on this Mac."), { code: "denied" });
        if (!sig.signed || sig.adhoc) throw Object.assign(new Error("This Capsule is ad-hoc signed, so Vyre cannot tell it apart from another app on this Mac. Reinstall it with `vyre capsule install`, which signs it, then try again."), { code: "denied" });
        if (sig.cdhash !== cdhash) throw Object.assign(new Error("A Capsule can only pin its own build."), { code: "denied" });
        return presence.pinCapsule(cdhash);
      },
    });

    ctx.tool("presence.code", {
      effect: "write",
      description: "A one-time code, valid 10 minutes, that enrolls one passkey from the Deck. Needs presence.",
      presence: { summary: async () => "Make a one-time code to enroll a passkey" },
      input: obj({}),
      run: async () => presence.mintCode(),
    });

    // The relay module's claim (relay.setup.claim) makes this after checking a signed claim token.
    // Nothing else may: a grant enrols a passkey with no other proof.
    ctx.tool("presence.grant.mint", {
      internal: true,
      description: "The one-time, five-minute grant that lets one browser enroll the first owner passkey. Only the relay module's checked claim makes it.",
      input: obj({ peer: { type: ["object", "null"] }, host: str }, ["host"]),
      run: async (input, meta = {}) => {
        if (String((meta && meta.caller) || "") !== "module:relay") throw new Error("only a checked claim makes a grant");
        return presence.mintGrant(input.peer || null, String(input.host || ""));
      },
    });

    ctx.tool("presence.session.open", {
      effect: "write",
      description: "After one strong proof (Touch ID, the Capsule, a device key or a passkey), a secret that proves presence for revealing, copying, TOTP codes and sends at the Gate for 30 minutes, on this device only.",
      presence: { summary: async () => "Keep revealing and copying vault items for up to 30 minutes on this device" },
      input: obj({}),
      run: async (_, meta) => {
        if (!meta.presence) throw new Error("a session opens from a person's proof, not from a module");
        return presence.openSession({ method: meta.presence.method, keyId: meta.presence.keyId, peer: meta.peer });
      },
    });

    // The person session (person.js): a browser signed in as the person, not only their device.
    const people = new PersonSessions({ db: ctx.store.db, softwareCap: Boolean(ctx.config && ctx.config.presence && ctx.config.presence.softwareKeyCap) });
    const nodeOf = meta => (meta.peer && (meta.peer.stableId || meta.peer.node)) || null;

    ctx.tool("presence.person.start", {
      effect: "write",
      description: "Sign this browser or app in as the person for 30 days (90 at most), on this device only, with a passkey or the device's own key. The Deck gets a cookie; with cc (a PKCE S256 challenge) the answer is a one-time code the app trades at /v1/person/token; a device paired over the relay sends its request-signing key (key, an ES256 public JWK) and gets the token itself.",
      presence: { summary: async input => {
        if (!input.cc) return "Sign this browser in for 30 days";
        let at = "an app";
        try { const u = new URL(String(input.return || "")); at = u.hostname === "127.0.0.1" ? "the vyre command line and Capsule on this Mac" : u.host; } catch {}
        return `Sign ${at} in on this device for 30 days`;
      } },
      callers: ["deck", "capsule"],
      input: obj({ cc: str, return: str, label: str, key: { type: "object" } }),
      run: async (input, meta) => {
        if (!meta.presence) throw new Error("a person session opens from a person's proof");
        const node = nodeOf(meta);
        const label = input.label || (meta.peer && meta.peer.node) || null;
        if (input.cc) {
          // The code goes back only to an app this box allows (network.origins), never to a page
          // that names itself: that page would hold the verifier and trade the code for the person.
          let back;
          try { back = new URL(String(input.return || "")); } catch { throw Object.assign(new Error("return must be the app's address"), { code: "bad_input" }); }
          const allowed = ((ctx.config.network || {}).origins || ["https://app.vyre.run"]).map(String);
          // A paired Mac's vyred (`vyre link signin`) listens on its own loopback, as a native
          // app does (RFC 8252). Its code is traded by vyred itself, never by a browser page.
          const loop = back.protocol === "http:" && back.hostname === "127.0.0.1" && /^\/cb\/[\w-]{16,}$/.test(back.pathname);
          // The native app (vyre://person/signin): its code is traded by the app itself, which
          // must also sign that trade with the key it registers (person.js exchange).
          const native = back.protocol === "vyre:" && back.host === "person";
          if (!loop && !native && (back.protocol !== "https:" || !allowed.includes(back.origin))) throw Object.assign(new Error(`${back.protocol === "vyre:" ? back.href : back.origin} is not an app this box signs in to`), { code: "denied" });
          const c = people.code({ node, cc: input.cc, origin: loop ? "loopback" : native ? "app:vyre" : back.origin, label });
          back.searchParams.set("code", c.code);
          return { kind: "code", code: c.code, expires: c.expires, redirect: back.href };
        }
        // A device paired over the relay (ADR 0026) has no browser to hold a cookie and no path to
        // the box's sign-in page. It proves the person with the key enrolled for it at pairing (a
        // phone's Secure Enclave or Keystore key, method device), and gets a token bound to the
        // request-signing key it sends, pinned to its device id.
        if (meta.peer && meta.peer.kind === "device") {
          if (meta.presence.method === "passkey") {
            // A relayed browser: its passkey is bound to this device id (presence checked it too).
            const b = /** @type {any} */ (ctx.store.db.prepare("SELECT device FROM presence_key_devices WHERE key = ?").get(String(meta.presence.keyId || "")));
            if (!b || b.device !== node) throw Object.assign(new Error("that passkey is not this device's"), { code: "denied" });
          } else if (meta.presence.method === "device") {
            const r = await ctx.call("relay.device.presence", { id: node }).catch(() => null);
            const mine = r && r.data && r.data.key;
            if (!mine || mine !== meta.presence.keyId) throw Object.assign(new Error("that key is not the one enrolled for this device"), { code: "denied" });
          } else throw Object.assign(new Error("a paired device signs in with its own device key or passkey"), { code: "denied" });
          const k = input.key;
          if (!k || k.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string" || k.d) throw Object.assign(new Error("key must be the public JWK of an ES256 key"), { code: "bad_input" });
          const s = people.start({ node, kind: "bearer", label, key: { kty: "EC", crv: "P-256", x: k.x, y: k.y }, keyId: meta.presence.keyId || null });
          ctx.events.emit("presence.signed-in", { id: s.id, node: label });
          return { kind: "bearer", id: s.id, token: s.token, expires: s.expires };
        }
        const s = people.start({ node, kind: "cookie", label, keyId: meta.presence.keyId || null });
        ctx.events.emit("presence.signed-in", { id: s.id, node: label });
        return { kind: "cookie", id: s.id, token: s.token, expires: s.expires };
      },
    });

    // ---- a paired session's strength ----------------------------------------------------------------------------------------------------------------
    // `software` is a session made with a key nobody had to touch. A device whose own key lives in the phone's Secure Enclave or the Android keystore (what the app reported at pairing, accepted
    // unattested for now: ruling 6410c6a) opens a session that is NOT software; a software key opens a software one, which the peer door counts as presence only where software proofs are taken
    // (a development build behind its switch). A session a phone approved takes the approving proof's strength instead (below).
    const verifiedStrength = (/** @type {any} */ rec) => (rec && typeof rec.proofStrength === "string" && STRENGTHS.includes(rec.proofStrength) && rec.proofStrength !== "software" ? rec.proofStrength : "software");
    /** The strength written on a paired session: from the key the device registered ("enclave, unattested": the app says Secure Enclave or keystore, no attestation verified), or the approving proof's when the owner's phone approved this sign-in. */
    const strengthOf = (/** @type {string} */ device, /** @type {any} */ rec, peek = false) => approvedStrength(device, peek) || verifiedStrength(rec);
    // ---- sign in approved on the owner's phone ---------------------------------------------------------------------------------------------------------------
    // A browser (software key, no passkey on the peer path) asks; the owner's phone shows "Let <device> sign in" and answers with its own proof; the browser then signs in as usual (pair-challenge, start-paired)
    // and that one session carries the strength of the approving proof (enclave, or unattested enclave), not the browser's key.
    const ASK_MS = 5 * 60_000;
    /** @type {Map<string, { id: string, device: string, label: string, state: "waiting" | "approved" | "refused", strong: boolean, method?: string, asked?: number, expires: number }>} */
    const asks = new Map();
    const liveAsk = (/** @type {string} */ device) => { const a = asks.get(device); if (a && a.expires <= Date.now()) { asks.delete(device); return null; } return a || null; };
    /** An approved, unexpired ask of this device with a strong approving proof; `peek` leaves it (the grant uses it once). */
    const approvedStrength = (/** @type {string} */ device, peek = false) => { const a = liveAsk(device); if (!a || a.state !== "approved" || !a.strong) return null; if (!peek) asks.delete(device); return a.method === "passkey" ? STRENGTHS[3] : STRENGTHS[2]; };
    const approvedStrong = (/** @type {string} */ device, peek = false) => approvedStrength(device, peek) !== null;

    // ---- an owner-paired device (ADR 0032 section 2d) ----------------------------------------------
    // The pairing, once the owner confirmed it with a presence proof, asks for one grant. This tool
    // trusts none of its arguments: it names the device, and the pair record (wink's, read here)
    // says who confirmed, what kind of device it is and which key it registered.
    ctx.tool("presence.person.pair-grant", {
      internal: true,
      description: "After the owner confirmed a pairing with a presence proof, the one-use grant that lets that device open its person session. Only the wink module may ask, and only for a device its own record says the owner confirmed.",
      input: obj({ device: str }, ["device"]),
      run: async (input, meta = {}) => {
        if (String((meta && meta.caller) || "") !== "module:wink") throw Object.assign(new Error("only the pairing makes a grant"), { code: "denied" });
        const r = await ctx.call("wink.device.record", { id: String(input.device) }).catch(() => null);
        const rec = r && r.data;
        if (!rec || rec.id !== input.device || !rec.confirmed || !rec.owner || rec.confirmedBy !== rec.owner) throw Object.assign(new Error("that device was not confirmed by its owner"), { code: "denied" });
        if (!["phone", "computer", "web"].includes(String(rec.kind))) throw Object.assign(new Error("only a phone, a computer or a browser paired to its owner gets a person session"), { code: "denied" });
        // Believed in hardware only when the pair record says so (platform attestation, wink's side); anything else is recorded as a software key, with no prompt (the sessions list shows it).
        const strength = strengthOf(String(input.device), rec), software = strength === "software";
        // The confirming key is the one the presence layer verified in the pairing's own call; the record is the fallback only for a pairing confirmed before this call.
        const keyId = (meta.presence && meta.presence.keyId) || rec.confirmKeyId || null;
        if (!keyId) throw Object.assign(new Error("the pairing carries no presence proof"), { code: "denied" });
        const g = people.grant({ device: rec.id, keyId: String(keyId), deviceKey: rec.key, software, strength });
        // The challenge goes back to the pairing, which hands it to the device; the device can also ask for it (presence.person.pair-challenge).
        return { granted: true, expires: g.expires, challenge: g.challenge, ...(software ? { software: true } : {}) };
      },
    });

    ctx.tool("presence.person.start-paired", {
      effect: "write",
      description: "A device its owner paired opens its person session: it signs `paired-start`, its id and the challenge of its grant with the key the owner confirmed. No prompt. Answers the token, or one refusal whatever the reason.",
      callers: RELAY_DEVICE_CALLERS,
      input: obj({ sig: str, label: str }, ["sig"]),
      run: async (input, meta = {}) => {
        const peer = meta.peer;
        const device = peer && peer.kind === "device" ? nodeOf(meta) : null;
        const refuse = () => Object.assign(new Error("this device cannot sign in that way; sign in with its key"), { code: "denied" });
        if (!device) throw refuse();
        const s = people.startPaired({ device, sig: String(input.sig), label: input.label || null });
        if ("refused" in s) {
          if (s.deleted) { locked.set(device, Date.now() + LOCK_MS); ctx.events.emit("presence.refused", { device, why: "pairing grant withdrawn after three wrong attempts" }); }
          throw refuse();
        }
        ctx.events.emit("presence.signed-in", { id: s.id, node: input.label || device });
        return { kind: "bearer", id: s.id, token: s.token, expires: s.expires };
      },
    });

    // ---- renewal (lead ruling, 4 Oct): a paired session is RENEWED, not re-paired -------------------------------------------------------------------------
    // A device that lapsed (its session idle past its time) and still holds the key the owner confirmed at pairing asks for its challenge and answers it with that key: the server makes the one-use grant
    // itself, from the pairing record wink keeps (confirmed by the owner, key on it, device not removed). No owner step. Three wrong answers lock the device for fifteen minutes; the owner lifts that
    // from their own device with `presence.person.renew-allow` (their presence). A removed device has no key on its record, so there is nothing to renew: re-pairing is for a removed device only.
    const LOCK_MS = 15 * 60_000;
    // The lock lives in the store, so a restart does not give a locked device fresh guesses.
    const locked = {
      get: (/** @type {string} */ d) => { const r = /** @type {any} */ (ctx.store.db.prepare("SELECT until FROM presence_renew_lock WHERE device = ?").get(String(d))); return r ? Number(r.until) : undefined; },
      set: (/** @type {string} */ d, /** @type {number} */ until) => { ctx.store.db.prepare("INSERT OR REPLACE INTO presence_renew_lock (device, until) VALUES (?, ?)").run(String(d), until); },
      delete: (/** @type {string} */ d) => { ctx.store.db.prepare("DELETE FROM presence_renew_lock WHERE device = ?").run(String(d)); },
      /** The locks still in the future, for the owner's Devices list. */
      live: () => /** @type {any[]} */ (ctx.store.db.prepare("SELECT device, until FROM presence_renew_lock WHERE until > ? ORDER BY until").all(Date.now())).map(r => ({ device: String(r.device), until: Number(r.until) })),
    };
    const renewGrant = async (/** @type {string} */ device) => {
      // a phone-approved sign-in (the owner's phone said yes to this device) is granted even when the device holds an older software grant: the session takes the approving proof's strength, once
      if (people.holds(device) && !approvedStrong(device, true)) return;
      const until = locked.get(device);
      if (until && until > Date.now()) return;
      const r = await ctx.call("wink.device.record", { id: device }).catch(() => null);
      const rec = r && r.data;
      if (!rec || rec.id !== device || !rec.confirmed || !rec.owner || rec.confirmedBy !== rec.owner || !rec.key || !["phone", "computer", "web"].includes(String(rec.kind))) return;
      try { const strength = strengthOf(device, rec); people.grant({ device, keyId: String(rec.confirmKeyId || `pairing:${device}`), deviceKey: rec.key, software: strength === "software", strength }); } catch { /* no grant: the device gets the random challenge */ }
    };
    ctx.tool("presence.person.locked", {
      effect: "read",
      description: "The paired devices that are locked after wrong sign-in answers, each with the time the lock ends by itself (ms): { locked: [{ device, until }] }. For the owner's Devices list; a removed device is never listed.",
      callers: ["cli", "local", "deck", "capsule", "mobile"],
      input: obj({}),
      run: async () => {
        const out = [];
        for (const l of locked.live()) { const r = await ctx.call("wink.device.record", { id: l.device }).catch(() => null); if (r && r.data && r.data.id === l.device) out.push(l); }
        return { locked: out };
      },
    });
    ctx.tool("presence.person.renew-allow", {
      effect: "write",
      description: "Lift the lock on a paired device that answered its sign-in challenge wrongly three times, from the owner's own device. The device then renews itself with its key.",
      presence: { summary: async input => `Let ${String((input && input.device) || "that device")} sign in again` },
      callers: ["cli", "local", "deck", "capsule"],
      input: obj({ device: str }, ["device"]),
      run: async input => { locked.delete(String(input.device)); return { allowed: String(input.device) }; },
    });

    ctx.tool("presence.person.session-ask", {
      effect: "write",
      description: "A paired device with no live session asks its owner's phone to let it sign in: { id, expires_in_s }. One open ask per device. The owner answers with presence.person.session-answer from their own device; then the device signs in as usual and its session has the approving proof's strength.",
      callers: RELAY_DEVICE_CALLERS,
      input: obj({ label: str }),
      run: async (input, meta = {}) => {
        const peer = meta.peer;
        if (!(peer && peer.kind === "device")) throw Object.assign(new Error("this device cannot ask that way"), { code: "denied" });
        const device = nodeOf(meta);
        const r = await ctx.call("wink.device.record", { id: device }).catch(() => null);
        const rec = r && r.data;
        if (!rec || rec.id !== device || !rec.confirmed || !rec.owner || rec.confirmedBy !== rec.owner) throw Object.assign(new Error("this device is not paired to an owner"), { code: "denied" });
        const open = liveAsk(device);
        if (open && open.state === "waiting") return { id: open.id, expires_in_s: Math.max(1, Math.round((open.expires - Date.now()) / 1000)) };
        const a = { id: `ask_${crypto.randomBytes(9).toString("base64url")}`, device, label: String(input.label || "a device").slice(0, 64), state: /** @type {const} */ ("waiting"), strong: false, asked: Date.now(), expires: Date.now() + ASK_MS };
        asks.set(device, a);
        ctx.events.emit("presence.session-asked", { id: a.id, device, label: a.label });
        return { id: a.id, expires_in_s: ASK_MS / 1000 };
      },
    });
    ctx.tool("presence.person.session-status", {
      effect: "read",
      description: "The state of this device's own sign-in ask: waiting, approved, refused, none (no such ask) or timeout.",
      callers: RELAY_DEVICE_CALLERS,
      input: obj({ id: str }, ["id"]),
      run: async (input, meta = {}) => {
        const peer = meta.peer;
        if (!(peer && peer.kind === "device")) throw Object.assign(new Error("this device cannot ask that way"), { code: "denied" });
        const a = asks.get(nodeOf(meta));
        if (!a || a.id !== String(input.id)) return { state: "none" };
        if (a.expires <= Date.now()) { asks.delete(a.device); return { state: "timeout" }; }
        return { state: a.state };
      },
    });
    ctx.tool("presence.person.session-pending", {
      effect: "read",
      description: "The sign-in asks still waiting for the owner, for their phone: { asks: [{ id, device, label, asked_at }] }, newest first. An ask lasts 5 minutes, then it is gone (so one made while the app was closed is still there when it opens).",
      callers: ["cli", "local", "deck", "capsule", "mobile"],
      input: obj({}),
      run: async () => {
        const out = [];
        for (const a of [...asks.values()]) { if (a.expires <= Date.now()) { asks.delete(a.device); continue; } if (a.state === "waiting") out.push({ id: a.id, device: a.device, label: a.label, asked_at: a.asked || 0 }); }
        out.sort((x, y) => y.asked_at - x.asked_at);
        return { asks: out };
      },
    });
    ctx.tool("presence.person.session-answer", {
      effect: "write",
      description: "The owner answers a device's sign-in ask from their own device, with their presence: yes lets that device sign in once, with the strength of this proof.",
      presence: { summary: async input => `Let a device sign in (${String((input && input.id) || "").slice(0, 24)})` },
      callers: ["cli", "local", "deck", "capsule", "mobile"],
      input: obj({ id: str, yes: { type: "boolean" } }, ["id", "yes"]),
      run: async (input, meta = {}) => {
        const a = [...asks.values()].find(x => x.id === String(input.id));
        if (!a || a.expires <= Date.now()) throw Object.assign(new Error("that sign-in ask is gone"), { code: "not_found" });
        if (a.state !== "waiting") return { state: a.state };
        if (input.yes !== true) { a.state = "refused"; return { state: "refused" }; }
        const p = /** @type {any} */ (meta.presence);
        // the approving proof's strength: a software key (method device) approves a software session; anything a person had to touch is strong
        a.strong = Boolean(p && p.method && p.method !== "device"); a.method = p && p.method ? String(p.method) : "";
        a.state = "approved";
        a.expires = Date.now() + ASK_MS;
        ctx.events.emit("presence.session-approved", { id: a.id, device: a.device, strong: a.strong });
        return { state: "approved" };
      },
    });
    ctx.tool("presence.person.pair-challenge", {
      effect: "write",
      description: "A device its owner paired asks for the challenge of its grant, to sign for presence.person.start-paired. A device with no grant gets a random one, so nothing says whether a grant exists.",
      callers: RELAY_DEVICE_CALLERS,
      input: obj({}),
      run: async (_, meta = {}) => {
        const peer = meta.peer;
        if (!(peer && peer.kind === "device")) throw Object.assign(new Error("this device cannot sign in that way; sign in with its key"), { code: "denied" });
        const device = nodeOf(meta);
        await renewGrant(device);
        return { challenge: people.challengeFor(device) };
      },
    });

    ctx.tool("presence.person.rotate", {
      effect: "write",
      description: "A paired device's session gets a new secret, signed by the device's key. The old one stops working.",
      callers: RELAY_DEVICE_CALLERS,
      input: obj({ t: str, n: str, sig: str }, ["t", "n", "sig"]),
      run: async (input, meta = {}) => {
        if (!meta.person) throw Object.assign(new Error("no person session"), { code: "denied" });
        const r = people.rotate({ id: meta.person.id, t: String(input.t), n: String(input.n), sig: String(input.sig) });
        if (!r) throw Object.assign(new Error("that rotation was not accepted"), { code: "denied" });
        return { kind: "bearer", id: r.id, token: r.token, expires: r.expires };
      },
    });

    // Removal of a device, its key leaving the identity list, a recovery reset or sign-out-everywhere: wink says so, here it ends.
    ctx.tool("presence.person.strength", {
      internal: true,
      description: "The strength of a live person session, for a module that relays a paired device's act to a person-only tool: { strength: one of STRENGTHS | null }. Only pluginagent asks.",
      input: obj({ id: str }, ["id"]),
      run: async (input, meta = {}) => {
        if (String((meta && meta.caller) || "") !== "module:pluginagent") throw Object.assign(new Error("only pluginagent asks a session's strength"), { code: "denied" });
        return { strength: people.strength(String(input.id)) };
      },
    });

    ctx.tool("presence.person.end-paired", {
      internal: true,
      description: "End every paired session and grant of one device, or of all devices when none is named. Only the wink module asks.",
      input: obj({ device: str }),
      run: async (input, meta = {}) => {
        if (String((meta && meta.caller) || "") !== "module:wink") throw Object.assign(new Error("only the pairing ends paired sessions"), { code: "denied" });
        const n = people.endDevice(input.device ? String(input.device) : undefined);
        if (n) ctx.events.emit("presence.signed-out", { device: input.device || "all" });
        return { ended: n };
      },
    });

    ctx.tool("presence.person.status", {
      effect: "read",
      description: "Whether this request is signed in as the person (a person session), and until when.",
      input: obj({}),
      run: async (_, meta) => ({ signed: Boolean(meta.person), ...(meta.person ? { id: meta.person.id, kind: meta.person.kind } : {}) }),
    });

    ctx.tool("presence.person.sessions", {
      effect: "read",
      description: "The browsers and apps signed in as the person: id, how (cookie or app), device, made, last used, when it lapses. Never a secret.",
      callers: ["cli", "local", "deck", "capsule"],
      input: obj({}),
      // A paired phone's own session sees only itself: it is not a window onto every other device's session.
      run: async (_input, meta = {}) => {
        const all = people.list(), me = meta && meta.person ? all.find(x => x.id === meta.person.id) : null;
        return { sessions: me && me.paired ? [me] : all };
      },
    });

    ctx.tool("presence.person.revoke", {
      effect: "write",
      description: "Sign one browser or app out now, by session id.",
      callers: ["cli", "local", "deck", "capsule"],
      input: obj({ id: str }, ["id"]),
      run: async ({ id }) => {
        if (!people.revoke(id)) throw Object.assign(new Error(`no session ${id}`), { code: "not_found" });
        ctx.events.emit("presence.signed-out", { id });
        return { revoked: id };
      },
    });

    ctx.tool("presence.covered", {
      internal: true,
      description: "Whether the device a call came from (its tailnet peer; none for this machine) has a live presence session, since when and until when (ms). The Gate and the Switchboard put it on held items and asks.",
      input: obj({ peer: { type: "object" } }),
      run: async ({ peer }) => presence.coverage(peer || null),
    });

    ctx.tool("presence.session.close", {
      effect: "write",
      description: "End a presence session now.",
      input: obj({ session: str }, ["session"]),
      run: async ({ session }) => ({ closed: presence.closeSession(session) }),
    });

    return { async stop() {} };
  },
};
