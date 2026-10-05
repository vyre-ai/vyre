// @ts-check
// wink: pairing as grants (spec: team/0.3/SPEC-wink-network.md section 6; DESIGN-wink.md section 4). Every way into a space is a Wink: a code
// or a scan on one device, a card on the other, and then exactly one grant (kernel/contracts/grant.d.ts) and a handful of events. There is no
// hidden way in. This module owns the flows on a box:
//
//   Add a phone               wink.phone.open  a QR and a long code; the phone scans or pastes it, both sides show the same three words, the person says yes
//                                              on the computer (wink.phone.pair.answer); no yes pairs nothing (core/wink/pairing.js). The ring (QR) path is the
//                                              existing pairing window; this module registers its devices too (device.paired, device.removed).
//   Typed code (development)  wink.code.open   a short typed code, two-sided (the PAKE of relay/client/code.js, wink.code.ack): off in a release build.
//   Invite a person           wink.invite      a Wink ticket with the offer sealed into it; the invited person's redemption becomes a membership
//                                              grant here (a sensitive role waits for the admin's approval).
//   Share a computer          wink.share       lend one of my computers to my own space: a node.host grant with limits.
//   See and remove            wink.access / wink.remove   every grant as a card with its last use; one removal does all of it.
//
// What this module does not do: the network. Joining a network (the control plane, the Wink core) is core/wink/control and core/wink/node,
// which this module will hand a one-time key to after the confirm; until they are wired, the relay path carries everything, which is correct.
// Everything user-facing is worded by cards.js (team/0.3/wink-copy.md). The code on screen is a secret: it is returned by the tool that
// opened it and never put on the event bus.

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createWinkCode } from "./code.js";
import { codeToAvatarBytes } from "../../relay/client/avatarcode.js";
import { createGrants, MIGRATIONS as GRANT_MIGRATIONS, spaceIdOf, timeId, base32 } from "./grants.js";
import { card, removal, removed, words } from "./cards.js";
import { registerReset } from "./reset.js";
import { createPairing, MIGRATIONS as DEVICE_MIGRATIONS, PEER_MIGRATIONS, FLOW_KIND, ADMIN_ROLES, ownDirectory, kernelDirectory, kernelHasRoles } from "./pairing.js";
import { createStorageDevices, registerStorageTools, MIGRATIONS as STORAGE_MIGRATIONS } from "./storage/index.js";
import { realScanners } from "./storage/discover.js";
import { lentRevoked } from "./lent-revoked.js";
import { dropIdentity } from "./drop-identity.js";
import { verifyDevice } from "./node/peer-wire.js";
import { storageGrants } from "./storage/grants.js";
import { attachPool } from "./storage/pool.js";
import { registerNetwork } from "./network.js";
import { identityPorts } from "./identity-ports.js";
import { createNetd } from "./netd.js";
import { createBridgeSecrets, createBridgeEndpoint, acceptDrive, bridgeServe, bridgeMakeBackend, pairFromHome, resumeServing, BRIDGE_TOOL, ACCEPT_TOOL, DRIVE_TOOL, SCAN_TOOL } from "./storage/bridge.js";
import { createHolds, holdDrive } from "./storage/hold.js";
import { seedFromKey } from "../../relay/client/join.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const OFFER_TTL = 5 * 60_000;
/** A typed code lives 10 minutes, and three wrong tries close it (a fresh one replaces it). */
const TYPED_TTL = 10 * 60_000;
const TYPED_TRIES = 3;
const INVITE_TTL_DAYS = 7;
const ROLES = new Set(["member", "contributor", "guest", "admin"]);
const SENSITIVE_ROLES = new Set(["admin"]);
const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest();
const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };

/** The owner's own surfaces only: never an agent, a guest, a hook or an anonymous caller. @param {any} meta @param {string} what */
function owner(meta, what) {
  const c = String((meta && meta.caller) || "");
  if (!c || (meta && meta.agent) || /^(anonymous|hook)$/.test(c) || c.startsWith("tailnet-guest:") || c.startsWith("agent:") || c.startsWith("tailnet:agent:") || c.startsWith("space:") || c.startsWith("org:"))
    throw fail("denied", `${what} is the owner's`);
}

/**
 * The Wink module. `inject.dataStores` is the kernel's list of data stores (core/wink/reset.js); without it a reset of an owned box refuses. `inject` is the composition root's side (the platform's createKernel passes these; every one is optional and a box without one says so plainly):
 *   directory   { memberships(identity) -> [{ space, name?, role }], label?(identity) }   who holds which role (kernelDirectory over ctx.kernel when absent)
 *   offers      { get(space, device, x), set(space, device, side, on, x) }   the ONLY store of compute offers (W-5); the kernel's grants.offers behind a port
 *   bridge      { createBridge, backendFor, home?, roots? } the pool engine'S bridge (kernel/storage/bridge.js, devices.js): a drive reached through another device (core/wink/storage/bridge.js)
 *   pool        the storage Pool engine (kernel/storage/pool.js) and poolBackend(credentials, offer) -> backend (kernel/storage/devices.js backendFor)
 *   ports       { typist, finish, adopt, callServer }   test seams for the typing flows
 *   typedCode   true switches the short typed code on (development; also VYRE_WINK_TYPED_CODE=1 or config wink.typedCode); off in a release build
 *   confirmAdopt false skips the person-at-the-server confirmation of a first adoption (a test seam; always on in a real box)
 *   releaseMaxMs how long a release the server never confirmed is retried before it is given up and the person is told (default 30 days)
 *   looseOwnerIds true (tests only) accepts owner ids of any length
 *   vyreName (identity) => the Vyre name the directory has claimed for that identity (e.g. "alex.vyre.run") or null: shown beside the asker's display name at the server
 *   identityEntry (identity, eid) => the entry on that identity's list ({ eid, kind, pub, identity? }) or null: proves the app for a server installed with --pair-to (Q-3)
 *   signIdentity (message) => { eid, sig }: this app's signature with a key on its own identity list, sent when it adopts a server (Q-3)
 * @param {{ ports?: import("./pairing.js").Ports, directory?: import("./pairing.js").Directory, pool?: any, poolBackend?: (c: any, offer: any) => any, bridge?: { createBridge: any, backendFor: any, home?: () => string | null, roots?: string[] }, offers?: any, network?: Parameters<typeof registerNetwork>[1], handover?: import("./pairing.js").Handover }} [inject]
 * @returns {{ start(ctx: any): Promise<{ stop(): Promise<void>, peers: any, homeServe(inner: any): any }>, readonly peers: any, homeServe(inner: any): any }} */
export function createWink(inject = {}) {
  /** @type {any} */
  let live = null;
  /** @type {(() => any) | null} */ let liveLinks = null;
  const mod = {
  async start(ctx) {
    // A server runs all of this. A person's computer that belongs to a server (machine "device") runs it too, as the client side: it pairs a server, reaches the Spaces hosted there (winkSessionFor, remoteKernel),
    // lends itself to them, and holds the connection a storage drive on its network is reached through. A computer on its own (machine "solo") stays out: nothing here is for it.
    if (ctx.config.role !== "box" && ctx.config.machine !== "device") return { async stop() {} };
    const now = () => Date.now();
    ctx.store.migrate([
      `CREATE TABLE wink_offers (id TEXT PRIMARY KEY, flow TEXT NOT NULL, via TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, body TEXT NOT NULL)`,
      `CREATE INDEX wink_offers_state ON wink_offers (state, expires)`,
      ...GRANT_MIGRATIONS,
      ...DEVICE_MIGRATIONS,
      ...STORAGE_MIGRATIONS,
      ...PEER_MIGRATIONS,
    ]);
    const db = ctx.store.db;
    let routeId = "";
    const ensureRoute = async () => {
      if (routeId) return routeId;
      const r = /** @type {any} */ (await ctx.call("relay.route.id", {}));
      if (!r || !r.data || !r.data.route) throw fail("unavailable", "this server has no relay route yet; turn the relay on first");
      routeId = String(r.data.route);
      return routeId;
    };
    const spaceId = async () => spaceIdOf(await ensureRoute());
    let spaceCache = "";
    // The table is made at start; the space is known once the relay has a route, and every grant call asks for it first.
    const grantsStore = createGrants({ ctx, space: () => spaceCache, now });
    const grants = async () => { spaceCache = await spaceId(); return grantsStore; };
    const actor = async (/** @type {"person" | "device"} */ kind, /** @type {string} */ id) => ({ kind, id, space: await spaceId() });
    /** The ONE identity of the person (DESIGN-wink 1): the spaces module owns it, claimed once through the names directory, so Wink reads it live and never makes a second one. A box whose home has no identity yet (a server before it is paired) falls back to an id derived from its route. */
    const identityId = async () => {
      try { const r = /** @type {any} */ (await ctx.call("spaces.identity.self", {})); return r && r.data && typeof r.data.id === "string" && r.data.id ? r.data.id : null; } catch { return null; }
    };
    const owner0 = async () => actor("person", (await identityId()) || `per_${base32(sha(`person\n${await ensureRoute()}`), 26)}`);

    // ---- offers: what is on screen right now, never a secret ----
    /** @param {string} flow @param {string} via @param {any} body @param {number} [ttl] */
    const newOffer = (flow, via, body, ttl = OFFER_TTL) => {
      const id = timeId("wo_", now());
      db.prepare("INSERT INTO wink_offers (id, flow, via, state, created, expires, body) VALUES (?, ?, ?, 'offered', ?, ?, ?)").run(id, flow, via, now(), now() + ttl, JSON.stringify(body));
      return id;
    };
    const readOffer = (/** @type {string} */ id) => {
      const r = /** @type {any} */ (db.prepare("SELECT * FROM wink_offers WHERE id = ?").get(String(id)));
      return r ? { id: r.id, flow: r.flow, via: r.via, state: r.state, created: r.created, expires: r.expires, ...JSON.parse(r.body) } : null;
    };
    const writeOffer = (/** @type {string} */ id, /** @type {string} */ state, /** @type {any} */ patch) => {
      const cur = readOffer(id);
      if (!cur) return null;
      const { id: _i, flow: _f, via: _v, state: _s, created: _c, expires: _e, ...body } = cur;
      db.prepare("UPDATE wink_offers SET state = ?, body = ? WHERE id = ?").run(state, JSON.stringify({ ...body, ...(patch || {}) }), id);
      return readOffer(id);
    };
    const sweep = () => {
      for (const r of /** @type {any[]} */ (db.prepare("SELECT id FROM wink_offers WHERE state IN ('offered', 'found', 'joining', 'pending') AND expires <= ?").all(now()))) {
        writeOffer(r.id, "expired", {});
        ctx.events.emit("wink.expired", { offer: r.id });
      }
    };
    const publicOffer = (/** @type {any} */ o) => {
      if (!o) return null;
      const { pick: _p, ticket: _t, ...rest } = o;
      return rest;
    };

    // ---- the typed code (two-sided) ----
    /** @type {any} */
    let code = null;
    /** @type {string | null} */
    let codeOffer = null;
    /** The code on screen, only ever returned to the person who opened it. @type {{ code: string, expires: number } | null} */
    let shown = null;
    const busName = (/** @type {string} */ n) => (n.startsWith("wink.code.") ? `wink.code-${n.slice("wink.code.".length)}` : n);
    /** What the relay said when it refused a code, for the words on the screen. @type {any} */
    let allocFail = null;
    /** Says what failed: the relay is out of date (426), the relay refused or did not answer, or it could not be reached. @param {any} err */
    const relayWords = err => {
      const m = String((err && (err.message || err.code)) || "");
      if (/426|out of date|upgrade/i.test(m)) return words("relayOld");
      if (/refus|did not confirm|already holds/i.test(m)) return `The relay would not take the code (${m.replace(/[.\s]+$/, "").slice(0, 160)}). Nothing was lost; try again in a minute.`;
      return words("offline");
    };
    const ensureCode = async () => {
      if (code) return code;
      const route = await ensureRoute();
      code = createWinkCode({
        route, twoSided: true, level: 2, ttlMs: TYPED_TTL, maxAttempts: TYPED_TRIES,
        allocate: async () => { const r = /** @type {any} */ (await ctx.call("relay.code.alloc", {})); allocFail = r && r.error ? r.error : null; return r && r.data ? r.data : null; },
        release: () => { void ctx.call("relay.code.release", {}); },
        emit: (name, data) => {
          if (name === "wink.code.opened" || name === "wink.code.replaced") { shown = { code: data.code, expires: data.expires }; const { code: _c, rv: _r, ...rest } = data; ctx.events.emit(busName(name), { offer: codeOffer, ...rest }); return; }
          if (name === "wink.code.closed") { shown = null; ctx.events.emit(busName(name), { offer: codeOffer, ...data }); return; }
          if (name === "wink.code.ack" && codeOffer) { writeOffer(codeOffer, "found", { pick: data.id }); ctx.events.emit("wink.found", { offer: codeOffer }); }
          ctx.events.emit(busName(name), { offer: codeOffer, ...data });
        },
      });
      return code;
    };
    // A typing device's PAKE message arrives from the relay as an internal event; the answer goes back the same way.
    const offCode = ctx.events.on("relay.code-asked", async (/** @type {any} */ e) => {
      const m = e.payload || e;
      if (!code) return;
      let out = null;
      try { out = code.handle({ rv: String(m.rv), s: String(m.s), n: Number(m.n), m: String(m.m) }); } catch {}
      await ctx.call("relay.code.reply", { q: String(m.q), ...(out ? { m: out.m } : {}) });
    });

    /** What a code carries to the typist once the ack is typed back (an invitation's link), by offer id. Memory only: a restart ends the code with it. @type {Map<string, any>} */
    const carried = new Map();
    /** Opens (or replaces) the showing code for one flow. @param {"W1" | "W2" | "W3" | "W5"} flow @param {any} [carry] sealed into the ticket the right ack makes */
    const openCode = async (flow, carry) => {
      sweep();
      const c = await ensureCode();
      // A new code always replaces the old one: the abandoned code is closed (its rendezvous goes back) and its offer is closed, so typing the old one fails plainly.
      if (codeOffer) { const prev = readOffer(codeOffer); if (prev && ["offered", "found", "joining"].includes(prev.state)) writeOffer(codeOffer, "closed", { why: "replaced" }); }
      c.cancel();
      carried.clear();
      codeOffer = newOffer(flow, "code", {}, TYPED_TTL);
      if (carry) carried.set(codeOffer, carry);
      const made = await c.open();
      if (!made) { writeOffer(codeOffer, "closed", {}); throw fail("unavailable", allocFail ? relayWords(allocFail) : words("relayNoCode")); }
      shown = { code: made.code, expires: made.expires };
      writeOffer(codeOffer, "offered", {});
      ctx.events.emit("wink.offered", { offer: codeOffer, flow, via: "code", expires: made.expires });
      return { offer: codeOffer, code: made.code, expires: made.expires };
    };
    /** The person typed back the code the other device shows. @param {string} offerId @param {string} typed */
    const ackOffer = async (offerId, typed, presence = null) => {
      sweep();
      const o = readOffer(String(offerId));
      if (!o || o.via !== "code" || o.state !== "found" || !o.pick || !code) throw fail("not_found", "no device is waiting to be added with that offer");
      const r = await code.ack(o.pick, String(typed));
      if (!r.ok) { writeOffer(o.id, "closed", { why: "wrong_code" }); ctx.events.emit("wink.declined", { offer: o.id, why: "wrong_code" }); return { ok: false }; }
      // Both ends hold the same key: the ticket's seed is derived from it, so the relay never sees it and nothing else is carried.
      const seed = Buffer.from(seedFromKey(r.key)).toString("base64url");
      const carry = carried.get(o.id);
      // A phone (W1) is gated like the QR's: the redemption is a waiting pairing, and the code's own confirmation is its yes (pairing.phone.codeSeed). Computers, servers and invitations are as before.
      const phoneFlow = o.flow === "W1" && !carry;
      const t = /** @type {any} */ (await ctx.call("relay.ticket.mint", { seed, ...(carry ? { offer: carry } : {}), ...(phoneFlow ? { gate: "phone" } : {}) }));
      if (!t || t.error) { writeOffer(o.id, "closed", { why: "relay" }); throw fail("unavailable", relayWords(t && t.error)); }
      carried.delete(o.id);
      writeOffer(o.id, "joining", { pick: null });
      if (phoneFlow) pairing.phone.codeSeed(seed, { ...(presence || {}), keyId: (presence && presence.keyId) || `ack:${o.id}` }); // the owner's typed-back ack is the confirmation the paired session is granted on
      ctx.events.emit("wink.confirmed", { offer: o.id });
      return { ok: true };
    };

    ctx.tool("wink.code.open", {
      description: "Show a short typed Wink code for a new computer or server (two-sided: the new device then shows a code to type back here, wink.code.ack). Switched off in a release build: it is refused unless VYRE_WINK_TYPED_CODE=1 or the config wink.typedCode is set; scan the QR or paste the long code instead. Answers { offer, code, expires }. The code is a secret: it is returned here and never put on the event bus.",
      input: obj({ flow: { type: "string", enum: ["W1", "W2", "W3"] } }),
      presence: { summary: async () => "Show a code to add a new device to this server" },
      run: async (input, meta = {}) => {
        owner(meta, "adding a device");
        if (!typedCodeOn()) throw fail("typed_code_off", words("typedCodeOff"));
        return openCode(input.flow || "W2");
      },
    });

    // An invitation's typed code (RC1): spaces.invites.create hands the invite's own link here and gets a short code for it. Whoever types the code, and whose ack the person types back here, receives that link inside
    // the ticket's sealed record (the long code, carried by the PAKE). It adds no way in: the link is the same one, and accepting it is the same accept. A code that cannot be made answers { code: null }.
    /** The avatar's 8 bytes for a typed code (the camera reader's picture of it), base64url. @param {string} code */
    const avatarBytes = code => { const b = codeToAvatarBytes(code); return b ? Buffer.from(b).toString("base64url") : null; };
    ctx.tool("wink.code.carry", {
      internal: true,
      description: "For the spaces module: show a short typed code that carries an invitation's link to the person who types it (and whose ack is typed back with wink.code.ack). Answers { code, offer, expires } or { code: null }. One typed code shows at a time: this replaces the one showing.",
      input: obj({ link: str, space: str }, ["link"]),
      run: async (input, meta = {}) => {
        if (String((meta && meta.caller) || "") !== "module:spaces") throw fail("denied", "only the spaces module carries an invitation");
        if (!typedCodeOn()) return { code: null };
        const link = String(input.link || "");
        if (link.length > 1500 || !/^https:\/\/[^\s]+$/.test(link)) throw fail("bad_input", "the link is an https address");
        try {
          const c = await openCode("W5", { v: 1, kind: "space-invite", link, ...(input.space ? { space: String(input.space).slice(0, 64) } : {}) });
          return { code: c.code, offer: c.offer, expires: c.expires, avatar: avatarBytes(c.code) };
        } catch { return { code: null }; }
      },
    });

    ctx.tool("wink.code.status", {
      description: "The code that is showing now, if any: { offer, code, expires, state }. The screen that opened it asks again after a replacement (a closed code is replaced with no tap).",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta, "the Wink code");
        sweep();
        const s = code ? code.status() : null;
        return { offer: codeOffer, ...(s ? { code: s.code, expires: s.expires } : { code: null }), state: codeOffer ? (readOffer(codeOffer) || {}).state || null : null };
      },
    });

    ctx.tool("wink.code.ack", {
      description: "Type back the code the new device is showing. One try per code: the right one adds the device and uses the code up, a wrong one closes the code and a new one is showing. Answers { ok }.",
      input: obj({ offer: str, typed: str }, ["offer", "typed"]),
      presence: { summary: async () => "Add this device to your server" },
      run: async (input, meta = {}) => { owner(meta, "adding a device"); if (!typedCodeOn()) throw fail("typed_code_off", words("typedCodeOff")); return ackOffer(input.offer, input.typed, meta.presence || null); },
    });

    ctx.tool("wink.cancel", {
      description: "Close an offer that has not been used: its code or invitation stops working. Answers { cancelled }.",
      input: obj({ offer: str }, ["offer"]),
      run: async (input, meta = {}) => {
        owner(meta, "cancelling an offer");
        const o = readOffer(String(input.offer));
        if (!o) throw fail("not_found", "no such offer");
        if (["done", "closed", "expired", "declined"].includes(o.state)) return { cancelled: false };
        if (o.via === "code" && codeOffer === o.id && code) code.cancel();
        writeOffer(o.id, "closed", { why: "cancelled" });
        ctx.events.emit("wink.declined", { offer: o.id, why: "cancelled" });
        return { cancelled: true };
      },
    });

    // ---- pairing: devices belong to the identity (pairing.js) ----
    const ownerMeta = () => { try { const r = /** @type {any} */ (db.prepare("SELECT v FROM wink_meta WHERE k = 'owner'").get()); return r ? JSON.parse(r.v) : null; } catch { return null; } };
    // The identity this box answers for: the one that adopted it (wink.server.adopt), else the person's identity this device holds (the spaces module keeps the one identity id: ONE identity
    // per person, never a second one here), else, before any is claimed, the one derived from its own route.
    const owner1 = async () => {
      const m = ownerMeta();
      if (m && m.identity) return String(m.identity);
      const r = /** @type {any} */ (typeof ctx.call === "function" ? await ctx.call("spaces.identity.id", {}).catch(() => null) : null);
      if (r && r.data && typeof r.data.id === "string" && r.data.id) return r.data.id;
      return (await owner0()).id;
    };
    /** What this box calls its own space: its name, else the name the app gave the space that adopted it, never "this space". */
    const boxName = () => { const om = ownerMeta(); return String(ctx.config.name || (om && om.kind === "space" && om.name) || "your space"); };
    const baseDirectory = inject.directory || (kernelHasRoles(ctx.kernel) ? kernelDirectory({ kernel: ctx.kernel, space: spaceId, name: boxName, label: id => { const om = ownerMeta(); return om && om.identity === id && om.name ? String(om.name) : null; } })
      : ownDirectory({ identity: owner1, space: spaceId, name: boxName }));
    // The spaces the person made here (spaces.create) are kernel-hosted Spaces with their own ids: they are targets too, beside the home's own, and the identity's name is the one it claimed.
    const directory = inject.directory ? baseDirectory : {
      async memberships(/** @type {string} */ identity) {
        const base = await baseDirectory.memberships(identity);
        let more = []; try { const r = await ctx.call("spaces.admin-list", { person: identity }); more = (r && r.data && r.data.spaces) || []; } catch { /* the spaces module is not here */ }
        return [...base, ...more.filter((/** @type {any} */ m) => !base.some(b => b.space === m.space))];
      },
      async label(/** @type {string} */ identity) {
        const own = baseDirectory.label ? await baseDirectory.label(identity) : null;
        if (own) return own;
        try { const r = await ctx.call("spaces.admin-list", { person: identity }); return (r && r.data && r.data.identity && r.data.identity.name) || null; } catch { return null; }
      },
    };
    // The short typed code is switched off in a release build (ruling, 4 Oct 2026; its cryptography still needs an independent review, team/0.3/PAKE-choice.md). One flag
    // for development: the env var VYRE_WINK_TYPED_CODE=1, or `wink.typedCode: true` in the config. Scan and paste always work.
    // RC1 (user ruling, 5 Oct 2026): the typed code is allowed on a release build, with a 10 minute life, three wrong tries per code and one use. `typedCodeOn` says it is allowed (config `wink.typedCode: false`, or VYRE_WINK_TYPED_CODE=0,
    // is the kill switch). `typedCodeDefault` is the older development switch: the install flow shows a typed code in place of the QR only when that is on.
    const typedCodeOn = () => inject.typedCode !== undefined ? Boolean(inject.typedCode) : !(process.env.VYRE_WINK_TYPED_CODE === "0" || (ctx.config && ctx.config.wink && ctx.config.wink.typedCode === false));
    const typedCodeDefault = () => inject.typedCodeDefault !== undefined ? Boolean(inject.typedCodeDefault) : (process.env.VYRE_WINK_TYPED_CODE === "1" || Boolean(ctx.config && ctx.config.wink && ctx.config.wink.typedCode === true));
    // The home's identity list and this device's signer, by the spaces module's own internal tools (read live every call, never cached). Given by `inject` first, so a test can pass fakes.
    /** @type {ReturnType<typeof createNetd> | null} */ let netdRef = null;
    const ports = identityPorts({ call: ctx.call.bind(ctx), space: spaceId });
    const identityEntry = inject.identityEntry || ports.identityEntry;
    const signIdentity = inject.signIdentity || ports.signIdentity;
    // What this device answers when its server calls back down the connection it holds (storage frames, a drive to accept, a scan): set once the storage side below exists.
    const serveRef = { fn: /** @type {(tool: string, input: any, from: string) => Promise<any>} */ (async () => { throw fail("denied", "This connection answers storage calls only."); }) };
    const pairing = createPairing({
      serve: (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ from) => serveRef.fn(tool, input, from),
      ctx, now, identity: owner1, space: spaceId, openCode, ack: ackOffer, owner, typedCode: typedCodeOn, typedDefault: typedCodeDefault,
      codeNow: () => { const o1 = codeOffer ? readOffer(codeOffer) : null; return shown && o1 && o1.state === "offered" ? { code: shown.code, expires: shown.expires, offer: codeOffer } : null; },
      cancelCode: () => { const o1 = codeOffer ? readOffer(codeOffer) : null; if (code && o1 && o1.flow === "W1" && ["offered", "found"].includes(o1.state)) { code.cancel(); writeOffer(codeOffer, "closed", { why: "used" }); } }, confirmAdopt: inject.confirmAdopt,
      releaseMaxMs: inject.releaseMaxMs,
      // Q-3: the identity port (the entry on an identity's list, read live) that checks the proof of a server installed to pair to one identity, and the app's own signer for that proof. A box given
      // neither refuses every unattended pairing ("cannot check who is asking"): naming an identity is never enough.
      identityEntry, signIdentity, identityPin: inject.identityPin || (async () => { const r = /** @type {any} */ (await ctx.call("spaces.identity.self", {}).catch(() => null)); return r && r.data && r.data.pin ? r.data.pin : null; }), identityVyre: inject.identityVyre || (async () => { const r = /** @type {any} */ (await ctx.call("spaces.identity.self", {}).catch(() => null)); return r && r.data && r.data.name ? String(r.data.name) : null; }),
      // The Vyre name for an identity id comes from the directory through the spaces module, which checks a name the app CLAIMS (owner.vyre) against the directory; a bare claim is never shown as a name.
      vyreName: inject.vyreName || (async (/** @type {string} */ id, /** @type {string | undefined} */ claimed) => { try { const r = await ctx.call("spaces.identity.name-of", { id, ...(claimed ? { claimed } : {}) }); return (r && r.data && typeof r.data.name === "string" && r.data.name) || null; } catch { return null; } }),
      // Who may pair to a space: the kernel's grants store when ctx.kernel offers it (work/kernel), else a fake that makes the box owner the owner of its own space.
      directory,
      ports: inject.ports,
      offers: inject.offers || (ctx.kernel && typeof ctx.kernel.offersPort === "function" ? ctx.kernel.offersPort() : undefined),
      // what a server being paired needs to reach this home: the built-in network's control address and a one-time join key when it has an address another machine can reach (netd.handover), else nothing
      handover: inject.handover || (async (/** @type {any} */ q) => (netdRef ? netdRef.handover(q) : null)),
      keyFile: path.join(ctx.paths && ctx.paths.root ? ctx.paths.root : path.join(os.homedir(), ".vyre"), "wink-keys.json"),
      spaceNow: () => spaceCache,
      relayUrl: async () => { const r = /** @type {any} */ (await ctx.call("relay.status", {})); return String((r && r.data && r.data.url) || (ctx.config.relay && ctx.config.relay.url) || ""); },
    });
    pairing.tools();
    registerReset({ ctx, pairing, now, identity: owner1, dropMs: inject.dropMs, dataStores: inject.dataStores || ctx.dataStores });
    live = pairing.peers;
    liveLinks = pairing.serverLinks;
    // handed up by name (core/modules provideOnce): the spaces and runner modules reach a paired server's peer session and kernel through ctx.sessionFor and ctx.remoteKernel
    try { ctx.provide("winkSessionFor", (/** @type {string} */ id) => pairing.serverLinks().sessionFor(id)); ctx.provide("winkInviteeSessionFor", (/** @type {any} */ channel, /** @type {any} */ hello, /** @type {any} */ about) => pairing.serverLinks().inviteeSessionFor(channel, hello, about)); ctx.provide("remoteKernel", (/** @type {string} */ id, /** @type {string} */ sp) => pairing.serverLinks().remoteKernel(id, sp)); } catch { /* provided already (a restart in one process), or no daemon (a test ctx) */ }
    /** A space's own name for a card, never its id. */
    const spaceName = async (/** @type {string} */ id) => {
      try { const m = (await directory.memberships(await owner1())).find(x => x.space === id); if (m && m.name) return String(m.name); } catch {}
      // the app named the space when it adopted this server (wink.server.adopt owner.name): a card says that name, never "this space"
      const om = ownerMeta();
      if (om && om.kind === "space" && om.id === id && om.name) return String(om.name);
      return "your space";
    };
    // A device that paired (a typed code, or a confirmed pairing) is registered under the identity with its kind. No grant is written in any space.
    // The relay marks how a device came (`via` in device.paired, `gate` too for a gated ticket) and a gated ticket makes no device until the person has picked the right words
    // (X-1): its redeemer is a waiting pairing (`pairing.pending`), held for the question below; this module confirms it to the relay only after that answer.
    // a waiting pairing's app went away and did not come back (the browser closed before the yes): drop its ask now, so the next scanner is not told "busy until restart"
    const offAbandoned = ctx.events.on("pairing.abandoned", (/** @type {any} */ e) => { try { pairing.abandoned(String((e.payload || e).device || "")); } catch { /* nothing waiting */ } });
    const offPending = ctx.events.on("pairing.pending", async (/** @type {any} */ e) => {
      const p = e.payload || e;
      try {
        const w = { id: String(p.device), name: p.name, fingerprint: p.fingerprint };
        if (p.gate === "phone") { if (!(await pairing.phone.hold(w))) await pairing.dropPending(w.id); }
        else if (p.gate === "ring") await pairing.phone.holdRing(w);
        // gate "server": the scanner completes its own adoption (wink.server.adopt), and the person at the server answers there
      } catch (err) { ctx.log(`wink: a waiting pairing could not be held: ${/** @type {Error} */ (err).message}`); await pairing.dropPending(String(p.device)).catch(() => {}); }
    });
    const registerDevice = async (/** @type {any} */ p) => {
      // A ring ticket the relay did not gate (only under the test switch VYRE_TEST_UNGATED_RING, which a packaged daemon ignores) is held for the words after the fact; every gated pairing has been
      // confirmed already, a window ticket was confirmed on a screen, a typed code by its ack.
      if (p.via === "ring" && !p.gate) { await pairing.phone.holdRing({ ...p, id: p.id }); return null; }
      const identity = await owner1();
      const open = /** @type {any} */ (db.prepare("SELECT id FROM wink_offers WHERE via = 'code' AND state = 'joining' ORDER BY created DESC LIMIT 1").get());
      const o = open ? readOffer(open.id) : null;
      // A typed-code join says which flow made it; a ring (QR) pairing is Add a phone (W1).
      const flow = o ? o.flow : "W1";
      const kind = /** @type {any} */ (FLOW_KIND)[flow] || "computer";
      const existing = pairing.devices.get(String(p.id));
      if (existing && !existing.removed) return existing;
      const dev = pairing.devices.add({ id: String(p.id), identity, kind, name: String(p.name || "a device"), fingerprint: String(p.fingerprint || ""), target: { kind: "identity", id: identity } });
      if (o) { writeOffer(o.id, "done", { device: dev.id, receiver: { name: p.name, fingerprint: p.fingerprint, device: p.id } }); ctx.events.emit("wink.joined", { offer: o.id, device: p.id, flow, kind }); }
      else ctx.events.emit("wink.joined", { device: p.id, flow, kind });
      return dev;
    };
    // Grants an older build wrote for devices become registry rows once, and the grants are revoked: a device is never a member of a space.
    let adopted = false;
    const adoptLegacy = async () => {
      if (adopted) return;
      adopted = true;
      const g = await grants();
      const identity = await owner1();
      /** @type {any[]} */ let legacy;
      // An event handler has no running call to build the kernel chain from, so the kernel refuses the list. That is the only error taken here, once, in one plain line: a server made by this build has no
      // legacy grants to adopt, and the pairing never waits on it (the device is registered first). Any other error still propagates.
      try { legacy = await g.list({ status: "active", source: "wink:W" }); }
      catch (e) { if (/kernel-built chain/.test(String(/** @type {Error} */ (e).message))) { ctx.log("wink: legacy device grants were not looked for (an event has no chain to ask the kernel with); a server made by this build has none"); return; } throw e; }
      for (const x of legacy) {
        const sub = x.subject.kind === "actor" ? x.subject.actor : null;
        if (!sub || sub.kind !== "device" || !x.actions.includes("space.act")) continue;
        const who = String(x.reason || "").split(", ");
        if (!pairing.devices.get(sub.id)) pairing.devices.add({ id: sub.id, identity, kind: /** @type {any} */ (FLOW_KIND)[String(x.source).slice(5)] || "computer", name: who[0], fingerprint: who[1], target: { kind: "identity", id: identity } });
        await g.revoke(x.id, "devices belong to your identity now");
      }
    };
    const offPaired = ctx.events.on("device.paired", async (/** @type {any} */ e) => { try { await registerDevice(e.payload || e); await adoptLegacy(); } catch (err) { ctx.log(`wink: device registration failed: ${/** @type {Error} */ (err).message}`); } });
    const offRemoved = ctx.events.on("device.removed", async (/** @type {any} */ e) => {
      const p = e.payload || e;
      try {
        if (pairing.devices.get(String(p.id))) { pairing.devices.remove(String(p.id)); ctx.events.emit("wink.removed", { device: p.id }); }
      } catch (err) { ctx.log(`wink: device removal failed: ${/** @type {Error} */ (err).message}`); }
    });

    // ---- a signed instruction to a headless box (lead ruling, 3 Oct): changing the relay is done from the owner's app WITH presence, and the box only
    // receives and checks the SIGNED instruction. There is no headless presence path. Format (v1):
    //   { v: 1, action: "relay.enable", url?, box, device, ts, nonce, sig }
    //   sig = signature by the owner device's signing key over "vyre-wink-instruction-v1\n<box>\n<action>\n<url>\n<ts>\n<nonce>"
    //         (Ed25519, or ECDSA P-256 with SHA-256 in the raw r||s form WebCrypto produces); `box` is this box's route id; `ts` within two minutes; a nonce is used once.
    // The key is the SPKI the owner's device registered with wink.device.key (presence, the owner's own screen). MISSING: the app side that signs (it must
    // enrol its key at pairing and sign after its own Touch ID), and a signing key bound to the identity chain; today the key is whatever the owner registered.
    const INSTRUCTION_SKEW = 2 * 60_000;
    const verifyInstruction = (/** @type {any} */ i, /** @type {any} */ dev, /** @type {string} */ box) => {
      if (!dev || !dev.signKey) return false;
      const msg = Buffer.from(`vyre-wink-instruction-v1\n${box}\n${i.action}\n${i.url || ""}\n${i.ts}\n${i.nonce}`);
      let key;
      try { key = crypto.createPublicKey({ key: Buffer.from(dev.signKey, "base64url"), format: "der", type: "spki" }); } catch { return false; }
      const sig = Buffer.from(String(i.sig || ""), "base64url");
      try {
        if (key.asymmetricKeyType === "ed25519") return crypto.verify(null, msg, key, sig);
        if (key.asymmetricKeyType === "ec") return crypto.verify("sha256", msg, { key, dsaEncoding: "ieee-p1363" }, sig);
      } catch { /* a malformed signature is a no */ }
      return false;
    };
    ctx.tool("wink.device.key", {
      description: "Register the key an owner's device signs instructions with (SPKI, base64url: Ed25519 or P-256), so a headless box can take a signed instruction from it (wink.relay.apply). Needs the owner's presence. Answers { device }.",
      input: obj({ device: str, key: str }, ["device", "key"]),
      presence: { summary: async () => "Let this device send signed instructions to your server" },
      run: async (input, meta = {}) => {
        owner(meta, "registering a signing key");
        const d = pairing.devices.get(String(input.device));
        if (!d || d.removed || d.identity !== await owner1() || (d.kind !== "phone" && d.kind !== "computer")) throw fail("not_found", "no such device of yours");
        let k;
        try { k = crypto.createPublicKey({ key: Buffer.from(String(input.key), "base64url"), format: "der", type: "spki" }); } catch { throw fail("bad_input", "the key is not a public key (SPKI, base64url)"); }
        if (k.asymmetricKeyType !== "ed25519" && k.asymmetricKeyType !== "ec") throw fail("bad_input", "the key is Ed25519 or P-256");
        pairing.devices.setSignKey(d.id, String(input.key));
        return { device: d.id };
      },
    });
    ctx.tool("wink.relay.apply", {
      description: "Apply a signed instruction from the owner's app to turn the relay on, or point it at another relay, on a box that has no screen. The app asks for presence and signs; this box checks the signature against the owner's registered device key, the box id, the time (two minutes) and a one-time nonce. Input is the instruction (see docs/work/tailnet.md). Answers { applied, url }.",
      input: obj({ v: { type: "number" }, action: { type: "string", enum: ["relay.enable"] }, url: str, box: str, device: str, ts: { type: "number" }, nonce: str, sig: str }, ["v", "action", "box", "device", "ts", "nonce", "sig"]),
      run: async (input, meta = {}) => {
        owner(meta, "changing the relay");
        const deny = (/** @type {string} */ why) => fail("denied", `the instruction was refused: ${why}`);
        if (input.v !== 1 || input.action !== "relay.enable") throw deny("not an instruction this box takes");
        const url = input.url ? String(input.url) : "";
        if (url && !/^wss?:\/\/[^\s/]+/.test(url)) throw fail("bad_input", "url must be a ws:// or wss:// address");
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(input.nonce))) throw deny("bad nonce");
        if (Math.abs(now() - Number(input.ts)) > INSTRUCTION_SKEW) throw deny("too old or from the future");
        if (String(input.box) !== await ensureRoute()) throw deny("meant for another box");
        const dev = pairing.devices.get(String(input.device));
        if (!dev || dev.removed || dev.identity !== await owner1() || (dev.kind !== "phone" && dev.kind !== "computer")) throw deny("not a device of the owner");
        if (!verifyInstruction({ ...input, url }, dev, String(input.box))) throw deny("the signature does not check out");
        const used = (pairing.meta.get("instr_nonces") || []).filter((/** @type {any} */ n) => n.exp > now());
        if (used.some((/** @type {any} */ n) => n.n === input.nonce)) throw deny("already used");
        pairing.meta.set("instr_nonces", [...used.slice(-199), { n: String(input.nonce), exp: now() + 2 * INSTRUCTION_SKEW + 1000 }]);
        const r = /** @type {any} */ (await ctx.call("relay.apply", url ? { url } : {}));
        if (r && r.error) throw fail(r.error.code || "unavailable", String(r.error.message || "the relay did not change"));
        ctx.events.emit("wink.relay-applied", { device: dev.id, ...(url ? { url } : {}) });
        return { applied: true, url: (r && r.data && r.data.url) || url || null };
      },
    });

    // ---- invite a person (W5) ----
    ctx.tool("wink.invite", {
      description: "Invite a person into this space: a Wink with the offer sealed into it (role and projects). Answers { offer, ticket, expiresAt }: show the ticket as a ring or a link. The invited person's own device redeems it and a card asks them to join; a sensitive role (admin) waits for your approval (wink.approve).",
      input: obj({ role: { type: "string", enum: ["member", "contributor", "guest", "admin"] }, projects: { type: "array", items: str }, days: { type: "number" }, name: str }),
      presence: { summary: async i => `Invite someone to this space as ${String((i && i.role) || "member")}` },
      run: async (input, meta = {}) => {
        owner(meta, "inviting a person");
        const role = String(input.role || "member");
        if (!ROLES.has(role)) throw fail("bad_input", "a role is member, contributor, guest or admin");
        const days = Math.min(Math.max(Number(input.days) || INVITE_TTL_DAYS, 1), 30);
        const projects = (Array.isArray(input.projects) ? input.projects : []).map(String).filter(p => /^[a-z0-9][a-z0-9-]{0,62}$/.test(p)).slice(0, 20);
        const space = await spaceId();
        const nameRes = /** @type {any} */ (await ctx.call("system.info", {}).catch(() => null));
        const spaceName = String((nameRes && nameRes.data && nameRes.data.name) || ctx.config.name || "this space").slice(0, 48);
        const offer = { v: 1, kind: "invite", space: { id: space, name: spaceName }, role, projects, inviter: { name: String(ctx.config.name || "an admin").slice(0, 48) }, exp: now() + days * 86_400_000 };
        const id = newOffer("W5", "ring", { role, projects, expires: offer.exp }, days * 86_400_000);
        offer.id = id;
        const t = /** @type {any} */ (await ctx.call("relay.ticket.mint", { offer }));
        if (!t || !t.data) { writeOffer(id, "closed", { why: "relay" }); throw fail("unavailable", relayWords(t && t.error)); }
        ctx.events.emit("wink.offered", { offer: id, flow: "W5", via: "ring", role, expires: offer.exp });
        return { offer: id, ticket: t.data.ticket, expiresAt: t.data.expiresAt };
      },
    });

    const offInvite = ctx.events.on("relay.invite-redeemed", async (/** @type {any} */ e) => {
      const p = e.payload || e;
      try {
        const o = readOffer(String((p.offer && p.offer.id) || ""));
        if (!o || o.flow !== "W5" || !["offered"].includes(o.state)) return;
        const fp = String(p.fingerprint || "");
        if (SENSITIVE_ROLES.has(o.role)) {
          // A sensitive role stays pending until an admin confirms the invitee's fingerprint words with presence.
          writeOffer(o.id, "pending", { receiver: { name: p.name, fingerprint: fp, key: p.pub } });
          ctx.events.emit("wink.found", { offer: o.id, flow: "W5" });
          return;
        }
        await admit(o.id, { name: p.name, fingerprint: fp, key: p.pub });
      } catch (err) { ctx.log(`wink: invitation failed: ${/** @type {Error} */ (err).message}`); }
    });
    /** Writes the membership: one grant, one event. @param {string} offerId @param {{ name?: string, fingerprint?: string, key: string }} who */
    const admit = async (offerId, who) => {
      const o = readOffer(offerId);
      if (!o) throw fail("not_found", "no such invitation");
      const g = await grants();
      const space = await spaceId();
      const grant = await g.create({
        subject: { kind: "actor", actor: { kind: "person", id: `per_${base32(sha(`person\n${who.key}`), 26)}`, space } },
        actions: ["member.act"], resource: { prefix: `vyre://${space}/` }, conditions: {},
        source: "wink:W5", reason: `${String(who.name || "someone")}, ${String(who.fingerprint || "")}, ${o.role}${(o.projects || []).length ? `, ${(o.projects || []).join(" ")}` : ""}`.trim(),
      }, await owner0());
      writeOffer(offerId, "done", { grant: grant.id, receiver: { name: who.name, fingerprint: who.fingerprint } });
      ctx.events.emit("wink.joined", { offer: offerId, grant: grant.id, flow: "W5", role: o.role });
      return grant;
    };
    ctx.tool("wink.approve", {
      description: "Approve a person who redeemed a sensitive invitation, after reading their fingerprint words back (the card shows them). Answers { grant }.",
      input: obj({ offer: str }, ["offer"]),
      presence: { summary: async () => "Let this person join this space with a sensitive role" },
      run: async (input, meta = {}) => {
        owner(meta, "approving a member");
        sweep();
        const o = readOffer(String(input.offer));
        if (!o || o.state !== "pending" || !o.receiver) throw fail("not_found", "nobody is waiting for approval on that invitation");
        const g = await admit(o.id, o.receiver);
        return { grant: g.id };
      },
    });
    ctx.tool("wink.decline", {
      description: "Say no to a person who redeemed a sensitive invitation. Nothing is added. Answers { declined }.",
      input: obj({ offer: str }, ["offer"]),
      run: async (input, meta = {}) => {
        owner(meta, "declining a member");
        const o = readOffer(String(input.offer));
        if (!o || o.state !== "pending") throw fail("not_found", "nobody is waiting for approval on that invitation");
        writeOffer(o.id, "declined", {});
        ctx.events.emit("wink.declined", { offer: o.id, why: "declined" });
        return { declined: true };
      },
    });

    // ---- share a computer (W4) ----
    ctx.tool("wink.share", {
      description: "Lend one of my own computers to my own space: it may run my sessions while it is awake, within the limits I set. Creates a node.host grant. Answers { grant }.",
      input: obj({ device: str, cpu: { type: "number" }, hours_day: { type: "number" }, awake: { type: "boolean" }, on_power: { type: "boolean" } }, ["device"]),
      presence: { summary: async i => `Share the computer ${String((i && i.device) || "")} with your space` },
      run: async (input, meta = {}) => {
        owner(meta, "sharing a computer");
        const dev = /** @type {any} */ (await ctx.call("relay.device.info", { id: String(input.device) }));
        const info = dev && dev.data;
        if (!info || info.removed || info.kind !== "app") throw fail("not_found", "that computer is not paired with this server");
        // A relay "app" row is a phone as well as a computer: the Wink device row says which. Only the person's own computer lends its compute.
        const wd = pairing.devices.get(String(input.device));
        const me = await owner1();
        if (wd && !wd.removed) {
          if (wd.kind !== "computer") throw fail("bad_input", "only a computer can be shared; a phone, a server or a storage device cannot lend its compute");
          if (wd.identity !== me) throw fail("denied", "that computer belongs to someone else");
        }
        const g = await grants();
        const space = await spaceId();
        const cpu = Math.min(Math.max(Number(input.cpu) || 0.5, 0.05), 1);
        const hours = Math.min(Math.max(Number(input.hours_day) || 8, 0.25), 24);
        const grant = await g.create({
          subject: { kind: "actor", actor: { kind: "person", id: (await owner0()).id, space } }, actions: ["node.host"],
          resource: { prefix: `vyre://${space}/node/${String(input.device)}/` },
          conditions: { budget: { meter: "node.cpu-hours-day", limit: hours * cpu }, where: { nodes: [String(input.device)] } },
          source: "wink:W4", reason: `shared with limits: cpu ${cpu}, ${hours} hours a day, awake ${input.awake !== false}, on power ${input.on_power === true}`,
        }, await owner0());
        // The grant records the limits; what the runner reads is the two sides of the compute offer (W-5). Sharing your own computer with your own space switches
        // the computer's compute offer on and records the member's side, so computeAllowed answers yes for the personal space and the runner may lease it.
        let allowed = null;
        if (wd && !wd.removed) {
          db.prepare("UPDATE wink_devices SET offers = ? WHERE id = ?").run(JSON.stringify({ ...wd.offers, compute: true }), wd.id);
          await pairing.compute.set(wd.identity, wd.id, "member", true, { member: wd.identity, device_key: wd.nodeKey || undefined });
          allowed = await pairing.computeAllowed({ device: wd.id, space: wd.identity });
        }
        ctx.events.emit("wink.shared", { grant: grant.id, device: String(input.device) });
        return { grant: grant.id, ...(allowed ? { allowed } : {}) };
      },
    });

    // ---- access: every grant as a card, and one way to take it back ----
    const cardOf = async (/** @type {any} */ g) => {
      const who = String(g.reason || "").split(", ");
      const kind = g.source === "wink:W5" ? "invite" : g.source === "wink:W4" ? "share" : "share";
      const c = card({ kind: /** @type {any} */ (kind), receiver: { name: who[0], fingerprint: who[1] }, space: "Personal", inviter: { name: String(ctx.config.name || "") } });
      return { id: g.id, source: g.source, since: g.created_at, status: g.status, subject: g.subject, resource: g.resource.prefix, lastUsed: g.last_used || null, card: c };
    };
    ctx.tool("wink.access", {
      description: "What you have added with a Wink: your devices (a phone, a computer, a server, a storage device, each with its kind, who it belongs to and what it offers) and the grants given to people, as cards. Devices belong to you, not to a space. Answers { devices, grants }.",
      input: obj({ status: { type: "string", enum: ["active", "revoked"] } }),
      run: async (input, meta = {}) => {
        owner(meta, "the access list");
        const g = await grants();
        await adoptLegacy();
        const list = await g.list({ ...(input.status ? { status: input.status } : { status: "active" }), source: "wink:" });
        const devices = await Promise.all(pairing.devices.list(await owner1()).map(async d => ({ ...d, card: card({ kind: /** @type {any} */ (d.kind), receiver: { name: d.name, fingerprint: d.fingerprint }, space: d.owner.kind === "space" ? await spaceName(d.owner.id) : "Personal" }) })));
        return { devices, grants: await Promise.all(list.map(cardOf)) };
      },
    });
    ctx.tool("wink.offers", {
      description: "What is waiting on a person right now: the offers that are showing or waiting for a card, without any secret. Answers { offers }.",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta, "the offers");
        sweep();
        const rows = /** @type {any[]} */ (db.prepare("SELECT id FROM wink_offers WHERE state IN ('offered', 'found', 'pending', 'joining') ORDER BY created DESC").all());
        return { offers: rows.map(r => publicOffer(readOffer(r.id))) };
      },
    });
    ctx.tool("wink.remove", {
      description: "Take something back: a grant (a member, a share) is revoked, or a device (give `device`) is removed with its connections closed, and a line is written. Answers { removed, prompt } where prompt is the words the screen showed before asking.",
      input: obj({ grant: str, device: str }),
      presence: { summary: async () => "Remove something you added with a Wink" },
      run: async (input, meta = {}) => {
        owner(meta, "removing a grant");
        if (input.device) {
          const d = pairing.devices.get(String(input.device));
          if (!d || d.removed || d.identity !== await owner1()) throw fail("not_found", "no such device");
          // A server or storage device is told to let go of its owner over the channel the app paired it on, so it can be paired again. The owner's
          // presence was given for this remove. One that cannot be reached keeps a pending release, applied when it next answers or is paired again.
          const release = d.kind === "server" || d.kind === "storage" ? await pairing.releaseServer(d.id) : undefined;
          await pairing.endPairedNow(d.id);
          pairing.devices.remove(d.id);
          // Its relay connections close at once through relay.devices.drop (a module's door to the relay's own removal); `closed` says what happened.
          let closed = false;
          // a server that let go (release "released") has ended its side of the channel itself, so the connection is closed then too
          if (d.kind === "server" || d.kind === "storage") closed = release === "released";
          else { const rr = /** @type {any} */ (await ctx.call("relay.devices.drop", { id: d.id })); closed = !rr.error && Boolean(rr.data && rr.data.closed); }
          ctx.events.emit("wink.removed", { device: d.id });
          return { removed: d.id, closed, ...(release ? { release } : {}), prompt: removal({ what: "device", name: d.name }).prompt, done: removed({ what: "device", name: d.name, release }) };
        }
        if (!input.grant) throw fail("bad_input", "say which grant or which device");
        const g = await grants();
        const gr = await g.get(String(input.grant));
        if (!gr || gr.status !== "active") throw fail("not_found", "no such grant");
        const subject = gr.subject.kind === "actor" ? gr.subject.actor : null;
        const label = String(gr.reason || "").split(", ")[0];
        await g.revoke(gr.id, "removed by the owner");
        // A device grant takes the device with it; its connections close at once (the relay's own removal).
        if (subject && subject.kind === "device") await ctx.call("relay.devices.drop", { id: subject.id });
        ctx.events.emit("wink.removed", { grant: gr.id, ...(subject && subject.kind === "device" ? { device: subject.id } : {}) });
        const what = gr.source === "wink:W4" ? "share" : gr.source === "wink:W5" ? "member" : "device";
        return { removed: gr.id, prompt: removal({ what: /** @type {any} */ (what), name: label, member: label, space: "this space" }).prompt, done: removed({ what, name: label, member: label, space: "this space" }) };
      },
    });

    ctx.tool("wink.card", {
      description: "The card for an offer or a grant: four lines and two buttons, in the words of team/0.3/wink-copy.md. Answers { card }.",
      input: obj({ offer: str, grant: str }),
      run: async (input, meta = {}) => {
        owner(meta, "the card");
        if (input.grant) { const g = await (await grants()).get(String(input.grant)); if (!g) throw fail("not_found", "no such grant"); return { card: (await cardOf(g)).card }; }
        const o = readOffer(String(input.offer));
        if (!o) throw fail("not_found", "no such offer");
        const kind = o.flow === "W5" ? "invite" : o.flow === "W3" ? "server" : o.flow === "W1" ? "phone" : "computer";
        return { card: card({ kind: /** @type {any} */ (kind), receiver: o.receiver || {}, space: o.flow === "W5" ? String(ctx.config.name || "this space") : "Personal", inviter: { name: String(ctx.config.name || "") }, level: 2 }) };
      },
    });

    // Storage devices (core/wink/storage): the vault holds a drive's login, and the pool engine reads offers through this seam.
    const sdata = (/** @type {any} */ r) => { if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r && r.data; };
    const storageVault = {
      put: async (/** @type {any} */ o) => { sdata(await ctx.call("vault.put", { name: o.name, kind: "env-set", description: o.description, fields: o.fields, grants: ["wink"] })); },
      fetch: async (/** @type {string} */ name, /** @type {string | undefined} */ field) => ctx.vault.fetch(name, field ? { field } : {}),
      remove: async (/** @type {string} */ name) => { sdata(await ctx.call("vault.delete", { name })); },
    };
    const storageAdmin = {
      self: async () => owner0(),
      isAdmin: async (/** @type {string} */ person, /** @type {string} */ sp) => {
        if (kernelHasRoles(ctx.kernel)) return (await kernelDirectory({ kernel: ctx.kernel, space: async () => sp, name: () => "" }).memberships(person)).some(m => ADMIN_ROLES.includes(m.role));
        return sp === (await spaceId());
      },
      nameOf: async (/** @type {any} */ o) => (o.kind === "person" ? "Personal" : boxName()),
    };
    // The folders a drive may be mounted under on this computer: the usual places, and any the person lists (config wink.storageRoots).
    const storageRoots = [...new Set(["/Volumes", "/mnt", "/media", ...(Array.isArray(ctx.config && ctx.config.wink && ctx.config.wink.storageRoots) ? ctx.config.wink.storageRoots.filter((/** @type {any} */ r) => typeof r === "string" && path.isAbsolute(r)) : [])])];
    // Drives only another device can reach: the home asks each device that holds a connection to it what it sees from where it sits (`wink.storage.bridge.scan`, answered down that connection), and lists them with the rest.
    const remoteCandidates = async () => {
      /** @type {any[]} */ const found = []; /** @type {string[]} */ const notes = [];
      for (const d of holds.devices()) {
        try {
          const r = /** @type {any} */ (await holds.linkTo(d).call(SCAN_TOOL, {}));
          for (const c of (r && Array.isArray(r.candidates) ? r.candidates : []).slice(0, 64)) found.push({ name: c.name, kind: c.kind, host: c.host, share: c.share, path: c.path, size: c.size, seenFrom: String((r && r.from) || d).slice(0, 60), seenFromDevice: d });
          for (const n of (r && Array.isArray(r.notes) ? r.notes : []).slice(0, 4)) notes.push(String(n).slice(0, 200));
        } catch (e) { notes.push(`A device could not look for drives (${String(/** @type {any} */ (e).code || "failed")}).`); }
      }
      return { found, notes };
    };
    const storage = createStorageDevices({ ctx, grants: storageGrants({ ctx, space: () => spaceCache }), vault: storageVault, admin: storageAdmin, space: spaceId,
      scanners: realScanners({ roots: storageRoots }), remoteCandidates, viaReach: (/** @type {string} */ d) => holds.has(d) });
    registerStorageTools(ctx, storage, "wink.storage");
    // `vyre doctor`'s Wink checks read the identity list through this port (a device on the list, by its entry id, in this home's space) and this device's own entry. The node host and the
    // relay clock stay absent here (they say "unknown", never a guess) until the daemon composes the node host (composeWinkHome).
    // The built-in network (core/wink/netd.js): Headscale, the gate and the Wink node, started in the background on a server home. It hands its node host to the
    // network status above; a box with no programs installed says "no-binary" there and the relay carries everything. `inject.netd === false` is a test seam that leaves it off.
    const netd = inject.netd === false ? null : createNetd({
      root: ctx.paths && ctx.paths.root ? ctx.paths.root : path.join(os.homedir(), ".vyre"),
      space: spaceId,
      box: async () => { const r = /** @type {any} */ (await ctx.call("relay.route.id", {})); return String((r && r.data && (r.data.box || r.data.route)) || ""); },
      entry: async (/** @type {string} */ eid) => { const r = /** @type {any} */ (await ctx.call("spaces.identity.entry", { space: await spaceId(), eid })); return r && !r.error ? (r.data !== undefined ? r.data : r) : null; },
      serve: ctx.peerDoor && ctx.peerDoor() && typeof ctx.peerDoor().serve === "function" ? ctx.peerDoor().serve : null,
      onSession: (/** @type {string} */ caller, /** @type {any} */ session) => { try { holds.onSession(caller, session); } catch { /* the hold is optional */ } },
      log: m => ctx.log(m),
      relayUrl: ctx.config && ctx.config.relay && typeof ctx.config.relay.url === "string" ? ctx.config.relay.url : "",
      enabled: !(process.env.VYRE_WINK_NET === "0" || (ctx.config && ctx.config.wink && ctx.config.wink.network === false)),
      ...(ctx.config && ctx.config.wink && typeof ctx.config.wink.controlUrl === "string" ? { controlUrl: ctx.config.wink.controlUrl } : {}),
      ...(inject.netd || {}),
    });
    registerNetwork(ctx, { identity: ports.network, ...(netd ? { host: () => netd.host() } : {}), ...(inject.network || {}), storage });
    netdRef = netd;
    if (netd) netd.start();
    const stopStorage = storage.startTimer();
    // The pool engine (work/sealing kernel/storage) is a library, not a module: a box that runs it passes the Pool and a backend factory (inject.pool,
    // inject.poolBackend; PORT until it is merged). Devices join the pool, usage and drains flow back, on every pairing and removal and once a minute.
    // A drive reached through another device (core/wink/storage/bridge.js, hold.js). The DEVICE holds one connection open to this home and the home calls back
    // on it: the host's `serveHome({ onSession: wink.holds.onSession })` hands each admitted session to `holds`, and `linkTo(device)` is the channel the pool's
    // backend sends frames down. The device side answers with `wink.bridgeServe` (the `serve` of `host.connect(space, { serve })`).
    const holds = createHolds({ log: m => ctx.log(m) });
    // handed up by name (core/modules provideOnce): the daemon's peer door gives each admitted device's session to `holds`, so the home can call back down the connection a drive's device keeps
    try { ctx.provide("winkHolds", holds); } catch { /* no registry to provide to: a test's module host */ }
    const bsecrets = createBridgeSecrets({ vault: storageVault });
    // The pool engine lives in the kernel (kernel/storage): the handle the kernel gives this module carries the Space's pool, `backendFor` and `createBridge` (kernel/index.js). A test or a composition root
    // that passes `inject.pool` / `inject.bridge` / `inject.poolBackend` replaces them.
    const kst = ctx.kernel && ctx.kernel.storage ? ctx.kernel.storage : null;
    const br = inject.bridge || (kst ? { createBridge: kst.createBridge, backendFor: kst.backendFor, home: () => pairing.homeServerId() } : null);
    // VyreDrop (core/files/drop-wink.js): the id of the server this computer is paired to, and, on the server, a call down the connection a computer holds (only the drop offer: nothing else goes down it this way).
    ctx.tool("wink.home.id", { description: "The id of the server this computer is paired to, or null.", input: obj(), run: async (/** @type {any} */ _i, /** @type {any} */ meta = {}) => { if (!String((meta && meta.caller) || "").startsWith("module:")) throw fail("denied", "for modules"); return { device: pairing.homeServerId() }; } });
    // A drop key says whose it is (VyreDrop, core/wink/drop-identity.js): only the files module, only the text `vyre-drop-key-v1\n<key>` built from the key. Not a way to have the identity key sign anything else.
    const dropId = dropIdentity({ sign: m => signIdentity(m), entry: async eid => identityEntry(await owner1(), eid), verify: verifyDevice });
    ctx.tool("wink.identity.sign", { description: "Sign a VyreDrop key with this computer's key on its identity's list.", input: obj({ pub: str }, ["pub"]), run: (/** @type {any} */ i, /** @type {any} */ meta = {}) => dropId.sign(meta, i) });
    ctx.tool("wink.identity.check", { description: "Whether a VyreDrop key was signed by a device on this person's identity list.", input: obj({ pub: str, eid: str, sig: str }, ["pub", "eid", "sig"]), run: (/** @type {any} */ i, /** @type {any} */ meta = {}) => dropId.check(meta, i) });
    ctx.tool("wink.device.call", { description: "Tell a connected computer something down the connection it holds (a drop is waiting). Only wink.drop.offer.", input: obj({ device: str, tool: str, input: { type: "object" } }, ["device", "tool"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
        if (!String((meta && meta.caller) || "").startsWith("module:")) throw fail("denied", "for modules");
        if (i.tool !== "wink.drop.offer") throw fail("denied", "only a drop offer goes down a held connection this way");
        return holds.linkTo(String(i.device)).call(String(i.tool), i.input || {});
      } });
    const noEngine = () => fail("unavailable", "This server has no storage engine to share a drive with.");
    const endpoint = createBridgeEndpoint({ createBridge: br ? br.createBridge : () => { throw noEngine(); }, secrets: bsecrets,
      // On a computer that serves a drive for its server, the offer's row is at the server, not here: the secret the server sealed to this computer and the one caller it answers are what bind a frame to the offer.
      live: offer => ctx.config.machine === "device" || storage.poolOffers().some((/** @type {any} */ o) => o.id === offer && o.state !== "expired" && o.state !== "removed"), log: m => ctx.log(m) });
    // The drives this computer serves are kept (wink_meta `served:<offer>`: the folder, the room and the one caller), so a restart serves them again; a record whose folder or secret is gone is dropped.
    const servedKeep = {
      put: (/** @type {{ offer: string, dir: string, capacity: number, caller: string }} */ r) => { db.prepare("INSERT INTO wink_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(`served:${r.offer}`, JSON.stringify(r)); ensureHold(); },
      all: () => /** @type {any[]} */ (db.prepare("SELECT v FROM wink_meta WHERE k LIKE 'served:%'").all()).map(x => { try { return JSON.parse(x.v); } catch { return null; } }).filter(Boolean),
      del: (/** @type {string} */ offer) => { db.prepare("DELETE FROM wink_meta WHERE k = ?").run(`served:${offer}`); },
    };
    const homeId = () => (br && br.home ? br.home() : null);
    const drive = acceptDrive({ endpoint, secrets: bsecrets, home: homeId, roots: br && br.roots ? br.roots : storageRoots, onServed: r => servedKeep.put(r) });
    const serveBridge = bridgeServe({ endpoint, drive, home: homeId, scan: async () => { const r = await storage.discovery.discover(); return { from: String(ctx.config.name || "a computer").slice(0, 60), candidates: r.candidates.map((/** @type {any} */ c) => ({ name: c.name, kind: c.kind, host: c.host, share: c.share, path: c.path, size: c.size })), notes: r.notes }; } });
    // The home's one message that is not storage: a grant for this computer ended, so the runner stops the Space's sessions here and deletes the local work and keys now (core/runner, runner.revoke).
    const lentRevokedFn = lentRevoked({ call: (/** @type {string} */ t, /** @type {any} */ i) => t === "spaces.server.of" ? ctx.call("spaces.server.of", i) : t === "runner.revoke" ? ctx.call("runner.revoke", i) : Promise.reject(Object.assign(new Error("not a tool lent-revoked calls"), { code: "denied" })), log: m => ctx.log(m) });
    serveRef.fn = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ from) => {
      if (tool === "wink.drop.offer") {
        // a drop waits for this computer on the server: only the server this computer is paired to may say so
        if (!from || from !== pairing.homeServerId()) throw fail("denied", "only the server this computer is paired to can offer a file");
        const id = input && typeof input.id === "string" ? input.id : "";
        if (!/^[a-z0-9]{20,40}$/.test(id)) throw fail("bad_input", "a drop's id");
        await ctx.call("files.drop.offered", { id });
        return { ok: true };
      }
      if (tool !== "wink.lent.revoked") return serveBridge(tool, input);
      return lentRevokedFn(input, from);
    };
    // A computer that belongs to a server keeps one connection to it (core/wink/storage/hold.js `holdDrive`): the server asks it down that connection what drives it can see, and sends the frames of a drive it serves.
    /** @type {{ stop(): void } | null} */ let held = null;
    function ensureHold() {
      if (held || ctx.config.machine !== "device") return;
      const sid = pairing.homeServerId();
      if (!sid) return;
      held = holdDrive({ connect: () => pairing.serverLinks().hold(sid), serve: serveBridge, space: sid, log: m => ctx.log(m) });
    }
    const dropHold = () => { if (held) { try { held.stop(); } catch { /* gone */ } held = null; } };
    const offHold = [ctx.events.on("wink.server-paired", ensureHold), ctx.events.on("wink.server-release", (/** @type {any} */ e) => { if (e && e.payload && e.payload.state === "released") dropHold(); })];
    if (ctx.config.machine === "device") {
      void resumeServing({ endpoint, kept: servedKeep.all(), roots: br && br.roots ? br.roots : storageRoots, forget: servedKeep.del }).catch(() => {});
      ensureHold();
    }
    const bridgeMake = br ? bridgeMakeBackend({ backendFor: br.backendFor, secrets: bsecrets, linkTo: d => holds.linkTo(d) }) : null;
    const makeBackend = inject.poolBackend || bridgeMake ? async (/** @type {any} */ c, /** @type {any} */ offer) => (offer.seenFromDevice && bridgeMake ? bridgeMake(c, offer) : inject.poolBackend ? inject.poolBackend(c, offer) : kst ? kst.backendFor(c, offer) : null) : null;
    const frameOf = (/** @type {any} */ meta) => String((meta && meta.caller) || "");
    ctx.tool(BRIDGE_TOOL, {
      description: "A storage frame for a drive this device serves, from the space's home (a put, get, delete or ping of one encrypted chunk, signed with the drive's secret). Answers { status, body? }. Only the home this device is paired to may ask.",
      input: obj({ offer: str, op: { type: "string", enum: ["put", "get", "del", "ping"] }, key: str, ts: { type: "number" }, nonce: str, sig: str, body: str }, ["offer", "op", "ts", "sig"]),
      run: (/** @type {any} */ input, /** @type {any} */ meta) => endpoint.handle(frameOf(meta), input),
    });
    ctx.tool(ACCEPT_TOOL, {
      description: "The device that has a drive accepts it from its home: step open answers a one-time key, step seal takes the drive's secret sealed to that key. The secret is never an input in the clear. Answers { pub } or { ok }.",
      input: obj({ offer: str, step: { type: "string", enum: ["open", "seal"] }, kind: str, location: { type: "object" }, capacity: { type: "number" }, epk: str, box: str }, ["offer", "step", "capacity"]),
      run: (/** @type {any} */ input, /** @type {any} */ meta) => drive(frameOf(meta), input),
    });
    ctx.tool(DRIVE_TOOL, {
      description: "Use a drive that only another device can reach: the home picks the drive (an offer from wink.storage.pick) and names the device that has it. That device is asked to open, the home makes the drive's secret and hands it over sealed, and the device starts serving. Answers { ok }. The device must be connected to this home.",
      input: obj({ offer: str, device: str }, ["offer", "device"]),
      presence: { summary: async () => "Use a drive through another device" },
      run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
        owner(meta, "using a drive through another device");
        if (!br) throw noEngine();
        const o = /** @type {any} */ (storage.poolOffers()).find((/** @type {any} */ x) => x.id === String(input.offer));
        if (!o) throw fail("not_found", "No such storage offer.");
        await pairFromHome({ secrets: bsecrets, linkTo: d => holds.linkTo(d) }, { offer: o.id, device: String(input.device), kind: o.kind, location: o.location, capacity: o.storage.capacity });
        poolSyncSoon();
        return { ok: true };
      },
    });
    const pool0 = inject.pool || (kst ? kst.pool : null);
    ctx.log(pool0 && makeBackend ? "wink storage: paired drives join this Space's pool" : "wink storage: no pool engine here, so a paired drive is recorded but nothing is placed on it");
    const poolLink = pool0 && makeBackend ? attachPool({ storage, pool: pool0, by: owner0, makeBackend, log: m => ctx.log(m) }) : null;
    const poolSyncSoon = () => poolSync();
    const poolSync = () => { if (poolLink) poolLink.sync().catch(err => ctx.log(`wink storage: pool sync failed: ${/** @type {Error} */ (err).message}`)); };
    const offStorage = [ctx.events.on("storage.paired", poolSync), ctx.events.on("storage.removed", poolSync)];
    // A drive picked from what another device saw is handed to that device as soon as it is paired: the device is asked to open, the home seals the drive's secret to it, and the device starts serving (core/wink/storage/bridge.js
    // pairFromHome). Until that is done the offer is recorded and the pool skips it; if it fails the person is told once and the drive stays listed as not connected.
    const offBridge = ctx.events.on("storage.paired", async (/** @type {any} */ e) => {
      const o = /** @type {any} */ (storage.poolOffers()).find((/** @type {any} */ x) => e && e.payload && x.id === e.payload.id);
      if (!o || !o.seenFromDevice || !br) return;
      try { await pairFromHome({ secrets: bsecrets, linkTo: d => holds.linkTo(d) }, { offer: o.id, device: o.seenFromDevice, kind: o.kind, location: o.location, capacity: o.storage.capacity }); poolSyncSoon(); }
      catch (err) { ctx.log(`wink storage: ${o.id} could not be handed to the device that has it (${/** @type {any} */ (err).code || "failed"}: ${String(/** @type {any} */ (err).message).slice(0, 120)})`); }
    });
    const poolTimer = poolLink ? setInterval(poolSync, 60_000) : null;
    poolTimer?.unref();

    const timer = setInterval(sweep, 60_000);
    timer.unref();
    return {
      peers: pairing.peers,
      holds,
      bridgeServe: serveBridge,
      homeServe: (/** @type {any} */ inner) => homeServe(pairing.peers, inner),
      ownHandover: () => pairing.ownHandover(),
      async stop() {
        live = null;
        liveLinks = null;
        clearInterval(timer);
        try { stopStorage(); } catch {}
        if (poolTimer) clearInterval(poolTimer);
        for (const off of offStorage) { try { off(); } catch {} }
        for (const off of offHold) { try { off(); } catch {} }
        try { offBridge(); } catch {}
        dropHold();
        for (const off of [offCode, offPaired, offRemoved, offInvite, offPending, offAbandoned]) { try { off(); } catch {} }
        try { code?.cancel(); } catch {}
        try { pairing.stop(); } catch {}
        try { if (netd) await netd.stop(); } catch {}
      },
    };
  },
  };
  // Non-enumerable, so the module loader sees only `start`: the home's peer admission (set after start) and its door dispatcher (see `homeServe` below).
  Object.defineProperty(mod, "peers", { enumerable: false, get() { if (!live) throw fail("unavailable", "the wink module has not started"); return live; } });
  // The home's held connections (`wink.holds.onSession` is the host's serveHome onSession) and the device's answer to the home's storage calls (`wink.bridgeServe`).
  Object.defineProperty(mod, "holds", { enumerable: false, get() { if (!live) throw fail("unavailable", "the wink module has not started"); return live.holds; } });
  Object.defineProperty(mod, "bridgeServe", { enumerable: false, get() { if (!live) throw fail("unavailable", "the wink module has not started"); return live.bridgeServe; } });
  // What this server was handed when it was adopted, WITH the secrets (auth key, peer secret), for core/wink/compose.js only: it is not a tool, so no other module can ask.
  // This device's open peer session to a server it paired (the one remote path): `wink.sessionFor(serverId)` -> { call(tool, input), close() }, `wink.remoteKernel(serverId, space)` the kernel's own
  // remote client over it, and `wink.startPaired(serverId)` this device's sign-in to that server (needs the app's key signer). Not tools: no other module can ask a tool for a session.
  Object.defineProperty(mod, "sessionFor", { enumerable: false, value: (/** @type {string} */ sid) => { if (!liveLinks) throw fail("unavailable", "the wink module has not started"); return liveLinks().sessionFor(sid); } });
  Object.defineProperty(mod, "remoteKernel", { enumerable: false, value: (/** @type {string} */ sid, /** @type {string} */ space) => { if (!liveLinks) throw fail("unavailable", "the wink module has not started"); return liveLinks().remoteKernel(sid, space); } });
  Object.defineProperty(mod, "startPaired", { enumerable: false, value: (/** @type {string} */ sid) => { if (!liveLinks) throw fail("unavailable", "the wink module has not started"); return liveLinks().startPaired(sid); } });
  Object.defineProperty(mod, "ownHandover", { enumerable: false, value: () => { if (!live) throw fail("unavailable", "the wink module has not started"); return live.ownHandover(); } });
  Object.defineProperty(mod, "homeServe", { enumerable: false, value: (/** @type {any} */ inner) => { if (!live) throw fail("unavailable", "the wink module has not started"); return homeServe(live, inner); } });
  return mod;
}

/**
 * The relay bridge's peer door for one space (core/relay/peers.js reads it as `ctx.peerDoor()`): `allow` from the Wink module's registry, `accept` from the node
 * host's own relay door. The composition root sets `ctx.peerDoor = () => peerDoor({ wink, host, space })` for the relay module.
 * @param {{ wink: { peers: { allow(deviceId: string): boolean } }, host: { acceptRelay(space: string): (stream: any, who: any) => void }, space: string }} o */
export function peerDoor(o) {
  return { space: o.space, allow: (/** @type {string} */ d) => o.wink.peers.allow(d), accept: o.host.acceptRelay(o.space) };
}

/**
 * The home's peer door dispatcher (kernel-2's ask, withKernelCall). `inner(caller, tool, input)` is the registry's dispatcher: one call as that caller, where `caller`
 * is `device:<id>` of a device that has just proved itself (a direct peer proved the key on its identity-list entry, a relay peer is authenticated by the relay
 * channel). It is `inner` unchanged: the node-key claim binding is gone (admission never read it), so there is nothing for Wink to wrap. Kept so callers keep one shape.
 *
 * @param {any} peers @param {(caller: string, tool: string, input: any) => Promise<any>} inner */
export function homeServe(peers, inner) { void peers; return inner; }

export { composeWinkHome } from "./compose.js";

export default createWink();
