// @ts-check
// relay: the way to reach the box that always works (ADR 0026). The box dials out to a
// relay; a device paired by QR code meets it there and runs a Noise IK handshake with the box's
// key. The box admits only devices it paired, names each one `device:<id>`, and hands its
// requests to vyred's router, where it is the owner on their own device.
// Presence is unchanged: being a person lets a device ask, never skips the proof.
//
// Off until the first pairing. Keys live in ~/.vyre/relay/keys.json (0600) and never leave the
// box: box.key is the Noise static key the QR carries, route.key proves the route to the relay.
//
// A device paired from the hosted web app (kind "web", ADR 0026 section 10) runs code fetched
// from app.vyre.run on each visit, so until the person trusts it from another device it cannot
// mint pairings, change trust, enroll presence keys or take a secret out of the vault, and it
// expires after `relay.web_expiry_days` without use. Its build is checked against the releases
// this box knows and shown with every pairing notice.

import crypto from "node:crypto";
import { devSwitch } from "../../kernel/devbuild.js";
import * as config from "../config/index.js";
import { within } from "../../lib/within.js";
import { friendlyDeviceName, cleanLabel } from "../../lib/devicename.js";
import { routeId, base32, TICKET_BYTES, TICKET_TTL, ticketDerive, ticketMac, ticketSeal, SETUP_TTL } from "./wire.js";
import { SetupSession, setupGate } from "./setup.js";
import { relayLink } from "./link.js";
import { createTunnelEnd } from "../../lib/publish/tunnel.js";
import { bridge } from "./bridge.js";
import { peersFor, inviteesFor, serversFor, homesFor } from "./peers.js";
import { pairUrl, parsePairUrl } from "./pairing.js";
import { knownBuild, findRelease, newestRelease } from "./releases.js";
import { agentClaim, ownerDevice } from "../modules/index.js";
import { loadKeys, keyHandle } from "./keys.js";
import { fingerprint8, toBase64url } from "../../lib/identity.js";
import { redeem } from "./redeem.js";
import { deviceIdOf } from "../../lib/caller.js";
import { DEFAULT_RELAY } from "../../lib/relay-default.js";
import { publishableRelay, relayUrlProblem } from "../../lib/relay-url.js";

export { loadKeys } from "./keys.js";
export { DEFAULT_RELAY } from "../../lib/relay-default.js";
const PAIR_TTL = 10 * 60_000;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
const DAY = 24 * 60 * 60_000;
/** What an untrusted web device may not call: minting devices, trust, presence keys, secrets out. */
export const WEB_DENY = /^(relay\.pair\.|relay\.devices\.trust$|relay\.enable$|relay\.web\.pin$|relay\.setup\.claim$|presence\.(enroll|code|remove)$|vault\.(reveal|copy|render|resolve|release|export|fill\.|session\.open$))/;
const BUILD = /^[\w.+-]{1,64}$/;

export const MIGRATIONS = [
  `CREATE TABLE relay_devices (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, pub TEXT NOT NULL, presence_key TEXT,
     paired_at INTEGER NOT NULL, last_seen INTEGER, removed_at INTEGER
   );`,
  `ALTER TABLE relay_devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'app';
   ALTER TABLE relay_devices ADD COLUMN release TEXT;
   ALTER TABLE relay_devices ADD COLUMN manifest TEXT;
   ALTER TABLE relay_devices ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE relay_devices ADD COLUMN node_id TEXT;
   ALTER TABLE relay_devices ADD COLUMN node_name TEXT;
   ALTER TABLE relay_devices ADD COLUMN last_path TEXT;
   ALTER TABLE relay_devices ADD COLUMN path_at INTEGER;
   ALTER TABLE relay_devices ADD COLUMN rtt INTEGER;`,
  // ADR 0046: a pairing that asked to join the tailnet leaves a grant; a node bound from a tagged
  // auth key is node_tagged, so revoke knows to delete it from the tailnet too.
  `ALTER TABLE relay_devices ADD COLUMN join_grant INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE relay_devices ADD COLUMN join_mints INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE relay_devices ADD COLUMN join_last INTEGER;
   ALTER TABLE relay_devices ADD COLUMN node_tagged INTEGER NOT NULL DEFAULT 0;`,
  // A removed device's tagged node still waiting on its API delete (the reviewer's LOW): kept
  // apart from node_id, so nothing can admit it, and kept for the record.
  `ALTER TABLE relay_devices ADD COLUMN orphan_node TEXT;`,
  // relay.devices.ask-trust: when an untrusted browser last asked to be trusted (once per limit).
  `ALTER TABLE relay_devices ADD COLUMN trust_asked INTEGER;`,
  // Where the app SAYS it made its device key (hardware | software | unknown), from the pairing hello: self-reported, display only (the Devices line shows only "software").
  `ALTER TABLE relay_devices ADD COLUMN key_storage TEXT NOT NULL DEFAULT 'unknown';`,
];
/** A direct report counts as the device's path for this long; the app reports on every switch. */
const DIRECT_FRESH = 10 * 60_000;
const LINK_TTL = 5 * 60_000;

/** The id a device is known by: the first 16 base32 characters of sha256 of its static key. */
export const deviceId = pub => base32(crypto.createHash("sha256").update(pub).digest()).slice(0, 16);

const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const str = { type: "string" };
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Shared by every relay tool that would create or persist a new key on this Mac before vyre-core
 * (ADR 0040) holds it instead: `relay.join` (this device's own identity key,
 * relay-device/key.json, core/relay/redeem.js) and `relay.pair.ticket` (a pairing whose secret and
 * MAC key derive from a ticket held only in this box's process, same as relay.pair.start's own
 * secret in relay/keys.json). All of it sits at the person's own login uid today, readable and
 * writable by any process at that uid, the same gap that already keeps relay hosting off by
 * default on local role (core/relay/keys.js, team/archive/work-journals/tailnet.md "Needs from others"). Refuse
 * plainly rather than ship the gap on any of these paths.
 *
 * A pure function of an explicit platform,,
 * so a test can assert the darwin case without depending on the OS it happens to run on.
 * With vyre-core holding the keys (`core`, keyHandle's flag) it lifts for every path: the box's own keys and this machine's device key (./devicekey.js) both stay in core.
 * @param {string} platform @param {boolean} [core]
 */
export function macCoreRefusal(platform, core = false) {
  return platform === "darwin" && !core
    ? fail("not_available_here", "not available on a Mac yet: this needs vyre-core to hold a key that today would sit unprotected at your login; use a Linux box instead, or wait for vyre-core")
    : null;
}

/**
 * Test seams, keyed by the VYRE_HOME a vyred runs with (the same pattern as core/link): a test sets the clock the pairing
 * window runs on. Never set outside tests.
 * @type {Map<string, { now?: () => number, pendingMs?: number }>}
 */
export const seams = new Map();

/**
 * @type {{ start(ctx: any, seam?: { WebSocket?: any, now?: () => number, pendingMs?: number, platform?: string, coreKeys?: any }): Promise<{ stop(): Promise<void> }> }}
 */
export default {
  async start(ctx, seam0 = {}) {
    const seam = { ...seam0, ...(seams.get(ctx.paths.root) || {}) };
    /** A seam read when it is used, so a test can change it after the relay started (the invitee channel lifetimes). @param {string} k */
    const liveSeam = k => (/** @type {any} */ (seams.get(ctx.paths.root)) || {})[k] ?? /** @type {any} */ (seam)[k];
    /** @type {Set<any>} the invitee channels open now (IV-5) */ const inviteePool = new Set();
    /** @type {Set<any>} the channels of strange homes open now (a project move's pull) */ const homePool = new Set();
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = seam.now || Date.now;
    const platform = seam.platform || process.platform;
    const settings = () => /** @type {any} */ ({ enabled: false, url: DEFAULT_RELAY, web_expiry_days: 30, tunnel_url: "", ...(ctx.config.relay || {}) });
    const save = patch => config.save({ relay: patch }, ctx.paths.root, ctx.config);
    // The box's keys, through a handle that never shows private bytes (./keys.js): vyre-core's when
    // `seam.coreKeys` is given, else the 0600 file. Public keys are plain values once `keys.ready()`
    // has run, which every path that starts the link, or answers with them, awaits first.
    const keys = keyHandle({ root: ctx.paths.root, core: seam.coreKeys || ctx.coreKeys || null });
    const k = () => keys;
    const route = () => routeId(keys.route.pub);
    // The box's name as the names module knows it (config.name), never the machine's hostname: it rides in QR codes and
    // shows in screenshots.
    const boxName = () => String(ctx.config.serverName || ctx.config.name || (ctx.config.network && ctx.config.network.name) || "Vyre box").slice(0, 64);
    // The claimed <handle>.vyre.run subdomain (core/names/service.js's own `ctx.config.name`,
    // set only once a name is actually claimed), not boxName()'s fallback chain, since a display
    // name is not necessarily a real, resolvable handle. Null when nothing is claimed yet: the
    // lead's 28 Sep ask (so a phone can offer <handle>.vyre.run after pairing, without a guess).
    const boxHandle = () => {
      const h = ctx.config.name;
      return typeof h === "string" && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/i.test(h) ? h.slice(0, 32) : null;
    };
    // The host of the box's own address (https://<handle>.vyre.run, or its own domain): where a phone
    // enrolls its passkey, and so the rp_id every enrolment grant is bound to.
    const addressHost = () => {
      try { return new URL(String((ctx.config.network || {}).address || "")).hostname.toLowerCase() || null; } catch { return null; }
    };
    // The box's own https origin (https://<handle>.vyre.run, or its own domain, with a port when not 443),
    // for a ticket's record: an app that pins the address pins this, from a record whose MAC covers it.
    const addressOrigin = () => {
      try { const u = new URL(String((ctx.config.network || {}).address || "")); return u.protocol === "https:" ? u.origin : null; } catch { return null; }
    };
    // The person's avatar seed (the lead's ruling, 28 Sep), from the one shared formula in
    // lib/identity.js so the box, system.info and the phone never disagree. A missing or malformed
    // owner.id gives null (no avatar), never a fabricated value.
    const identityFingerprint = () => {
      try { return toBase64url(fingerprint8(ctx.config.owner && ctx.config.owner.id, "person")); } catch { return null; }
    };

    /** One live pairing at a time: its secret's hash, when it ends, and whether it is the first device's. */
    /** @type {{ hash: Buffer, exp: number, first: boolean } | null} */
    let pairing = null;
    /** Live ticket-minted pairings (ADR 0045), any number at once, each single-use: the pairing
     * secret's hash keyed by itself (hex), same check as `pairing` above but there can be several. */
    /** @type {Map<string, { exp: number }>} */
    const pendingTickets = new Map();
    // (an entry may carry `offer`: a Wink invitation sealed into the same ticket, handled by core/wink)
    /** Does a presented secret match a live pairing (the classic single one, or a ticket's), and
     * burn it either way? Null when nothing matches. */
    const takeLiveSecret = provided => {
      const h = sha(provided);
      if (pairing && pairing.exp > now() && crypto.timingSafeEqual(h, pairing.hash)) { const m = { first: pairing.first, ticket: false, via: "start" }; pairing = null; return m; }
      const hex = h.toString("hex");
      const t = pendingTickets.get(hex);
      if (t && t.exp > now()) { pendingTickets.delete(hex); return { first: false, ticket: true, via: t.via || (t.window ? "window" : "ticket"), ...(t.gate ? { gate: t.gate } : {}), ...(t.window ? { window: t.window } : {}), ...(t.offer ? { offer: t.offer } : {}) }; }
      for (const [k, v] of pendingTickets) if (v.exp <= now()) pendingTickets.delete(k);
      return null;
    };
    /** Open channels per device id, so removing a device closes it at once. */
    /** @type {Map<string, Set<any>>} */
    const live = new Map();

    const active = () => /** @type {any[]} */ (db.prepare("SELECT id, name, pub, presence_key, paired_at, last_seen, kind, release, manifest, trusted, trust_asked, node_id, node_name, last_path, path_at, rtt, key_storage FROM relay_devices WHERE removed_at IS NULL AND kind NOT IN ('setup', 'server') ORDER BY paired_at").all());
    const expired = d => d.kind === "web" && now() - (d.last_seen || d.paired_at) > Number(settings().web_expiry_days) * DAY;
    const personExists = () => active().length > 0 || Boolean(ctx.config.network && ctx.config.network.owner);

    // Text someone else chose (a device's own name at pairing, another box's name or relay host
    // in a Touch ID prompt) lands somewhere the person reads and trusts: strip control
    // characters, newlines and Unicode format/bidi characters (which can visually reorder or hide
    // part of a quoted string) and cap the length, so it cannot write its own fake trailer, a
    // right-to-left override, or anything else into that text (reviewer, 28 Sep). The set is
    // C0/C1 controls, the Arabic letter mark (U+061C) and Mongolian vowel separator (U+180E),
    // zero-width and word-joiner/invisible-operator characters, line/paragraph separators and the
    // bidi override/embedding/isolate block, and the BOM.
    const promptSafe = (s, fallback, max = 40) => String(s || fallback)
      .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, " ")
      .replace(/ {2,}/g, " ").trim().slice(0, max) || fallback;

    /** Reads and changes are the owner's: never a guest's, an agent's, a hook's or anonymous. */
    const owner = (caller, meta, what) => {
      const c = String(caller || "");
      if (c.startsWith("tailnet-guest:")) throw fail("denied", `${what} is the owner's; a guest never sees the box's devices`);
      if ((meta && meta.agent) || agentClaim(c)) throw fail("denied", `"${c}" is an agent; ${what} is the owner's`);
      if (["anonymous", "hook"].includes(c)) throw fail("denied", `${what} is the owner's`);
      // a bare model session ("mcp", "harness") and a Vyre-owned session are not the owner either (platform-3: relay.status let a bare mcp through)
      if (/^(mcp|harness|session)(?=$|[\s:])/.test(c) || /(?:^|[\s:])thread:/.test(c)) throw fail("denied", `${what} is the owner's, not a model's`);
    };

    // ---- the link ----

    /** @type {ReturnType<typeof relayLink> | null} */
    let link = null;
    const startLink = () => {
      if (link) return;
      link = relayLink({
        url: settings().url, route: route(), routeKey: k().route, boxKey: k().box, admit, onchannel,
        WebSocket: seam.WebSocket, log: m => ctx.log(m),
        // A Publish tunnel stream the relay hands the box (relay/node/tunnel.js): the box end of the tunnel (`ctx.tunnelEnd`, the daemon's, from lib/publish/tunnel.js) takes it, or it is closed.
        ontunnel: (stream, visitor) => { const end = /** @type {any} */ (ctx).tunnelEnd; if (end && typeof end.accept === "function") end.accept(stream, visitor); else stream.destroy(); },
        // A typed Wink code's PAKE message from a typing device (spec 6.5): handed to the wink module as an internal event, never to a surface.
        oncode: m => { try { ctx.events.emit("relay.code-asked", m); } catch {} },
        onstate: (s, why) => {
          try { ctx.events.emit(s === "connected" ? "relay.connected" : "relay.disconnected", s === "connected" ? {} : { why: why || "" }); } catch {}
        },
      });
    };
    const stopLink = () => { link?.stop(); link = null; };

    // ---- the public tunnel (R032-02: an outside signer reaches this box with no inbound port) ----
    // A second, control-only link to the TUNNEL relay (relay.tunnel_url, a Node relay with public 443). The relay reads one SNI name from a visitor's TLS hello, asks the name directory which box serves it
    // (only boxes that declared an app or a share, only the box's own name and one label under it), and sends the bytes down this box's own outbound connection. The bytes are ciphertext: the box's public
    // gate (core/wink/control/gate.js) holds the certificate, made here by DNS-01, so the relay can read neither the page nor mint a certificate. This end connects each stream to that gate on loopback and
    // nothing else (lib/publish/tunnel.js): it never dials an address the relay names, and refuses a name that is not this box's. No device ever comes in on this link.
    /** @type {ReturnType<typeof relayLink> | null} */
    let tlink = null;
    let gatePort = /** @type {number | null} */ (null);
    const tunnelUrl = () => { const u = (settings()).tunnel_url; return typeof u === "string" && /^wss?:\/\/[^\s/]+(?::\d+)?\/?$/.test(u) ? u : ""; };
    const zone = () => String((ctx.config.names && ctx.config.names.zone) || "vyre.run");
    /** The own domains the person named for their apps (sign.firm.com): a stream for one is this box's too, once the directory has listed it. Kept from the apps module, refreshed with the gate's port. @type {string[]} */
    let ownHosts = [];
    const tunnelEnd = createTunnelEnd({
      name: () => (boxHandle() && ctx.config.network && ctx.config.network.via === "vyre.run" ? `${boxHandle()}.${zone()}` : null),
      own: () => ownHosts,
      port: () => gatePort,
      log: (what, x) => ctx.log(`relay: tunnel: ${what}${x && /** @type {any} */ (x).why ? " " + /** @type {any} */ (x).why : ""}`),
    });
    const refreshGate = async () => {
      try { const r = /** @type {any} */ (await ctx.call("wink.gate.port", {})); const p = r && r.data && r.data.port; gatePort = Number.isInteger(p) ? p : null; } catch { gatePort = null; }
      try { const r = /** @type {any} */ (await ctx.call("appmods.domain.list", {})); const d = r && r.data; ownHosts = d && Array.isArray(d.domains) ? d.domains.map((/** @type {any} */ x) => String(x.host)) : []; } catch { ownHosts = []; }
    };
    const startTunnel = async () => {
      if (tlink || !tunnelUrl() || !boxHandle()) return;
      try { await keys.ready(); } catch { return; }
      await refreshGate();
      if (tlink) return;
      tlink = relayLink({
        url: tunnelUrl(), route: route(), routeKey: k().route, boxKey: k().box,
        admit: async () => { throw new Error("this link carries public visitors only"); }, onchannel: () => {},
        WebSocket: seam.WebSocket, log: m => ctx.log(m),
        ontunnel: (stream, visitor) => { void refreshGate(); tunnelEnd.accept(stream, visitor); },
        onstate: (st, why) => { try { ctx.events.emit(st === "connected" ? "relay.tunnel-connected" : "relay.tunnel-disconnected", st === "connected" ? {} : { why: why || "" }); } catch {} },
      });
    };
    const stopTunnel = () => { tlink?.stop(); tlink = null; tunnelEnd.closeAll(); };

    /** Who may come in: a paired device, or a device holding the live pairing secret. */
    /** @type {Map<string, { at: number, n: number }>} one line per reason per minute, with a count of the repeats (an outsider opening channels cannot flood the log) */
    const refusals = new Map();
    function refusedLog(/** @type {string} */ why) {
      const t = now(), r = refusals.get(why);
      // a repeat inside the minute still says its reason, for the first few (a person retrying a pairing must see why each try was refused); past that it is only counted, so an outsider cannot flood the log
      if (r && t - r.at < 60_000) { r.n++; if (r.n <= 5) ctx.log(`relay: refused again (${why}); ${r.n} more like it this minute`); return; }
      ctx.log(`relay: refused a hello (${why})${r && r.n ? `; ${r.n} more like it in the last minute` : ""}`);
      refusals.set(why, { at: t, n: 0 });
      if (refusals.size > 50) refusals.delete(refusals.keys().next().value);
    }
    async function admit(pub, hello) {
      try { return await admit0(pub, hello); }
      catch (e) { refusedLog(String(/** @type {Error} */ (e).message || e).slice(0, 160)); throw e; }
    }
    async function admit0(pub, hello) {
      const id = deviceId(pub);
      // The setup page (tailnet plan 3.6b) is its own path: a hello that says "setup", or a device
      // the setup session already admitted, is checked against the setup code's key and nothing else.
      const existing = /** @type {any} */ (db.prepare("SELECT kind FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if ((hello && hello.setup && typeof hello.setup === "object") || (existing && existing.kind === "setup")) return admitSetup(pub, hello, id, existing);
      // An invitee (DESIGN-spaces-first.md): a person who is not a member of any space here reaches the home for one purpose. The channel makes no device row, no presence key and no session; it may
      // open only the invitee peer stream, whose door (core/daemon/peer-door.js) checks the identity proof and the invite. A key that is a paired device here is not an invitee on this hello.
      if (hello && hello.invitee === true && !existing && !pendingPairs.has(id)) return { v: 1, box: { name: boxName() }, invitee: id };
      // A HOME (the target of a project move): another box that holds no row here and asks for one thing. The channel is admitted only while a move is open on this home (the door says so), makes no
      // device row, no presence key and no session, and may open only the pull stream (core/daemon/peer-door.js acceptHome). A key that is a paired device here is not a home on this hello.
      if (hello && hello.homeMove === true && !existing && !pendingPairs.has(id)) {
        const homes = homesFor(ctx);
        if (!homes || !homes.homeOpen()) throw new Error("no move is open on this box");
        if (typeof /** @type {any} */ (homes).homeArrive === "function") /** @type {any} */ (homes).homeArrive();
        return { v: 1, box: { name: boxName() }, home: id };
      }
      if (hello && typeof hello.pair === "string") {
        const match = takeLiveSecret(hello.pair);
        if (!match) throw new Error("this pairing code has expired or was already used; make a new one on the box");
        if (match.first && personExists()) throw new Error("this box already has a device; if that was not you, remove it from Settings, Devices");
        const name = friendlyDeviceName(promptSafe(typeof hello.name === "string" ? hello.name.trim() : "", "a device", 64), { kind: hello.kind === "web" ? "web" : "device", owner: (ctx.config.onboard || {}).person });
        // A Wink invitation (core/wink): redeeming it enrols no device here. The person who was invited becomes a member of this space
        // through the wink module, which hears the event below and writes the grant. Nothing about the invitee's other devices crosses.
        if (match.offer && match.offer.kind === "invite") {
          ctx.events.emit("relay.invite-redeemed", { name, fingerprint: keyFingerprint(pub), pub: pub.toString("base64url"), offer: match.offer });
          return { v: 1, box: { name: boxName() }, paired: true, invite: true };
        }
        // A gated ticket (X-1, 4 Oct 2026) makes NOTHING until the module that gates it says yes: no device row, no presence key and no bridge session, only a waiting
        // pairing that may reach the one tool its own pairing needs. The ticket is spent either way.
        if (match.gate) return holdPending(pub, id, name, hello, match);
        // A ticket from a pairing window enrols nothing until the screen that opened it confirms this exact phone.
        if (match.window) await holdForConfirm(match.window, pub, name);
        const reply = await enrol(pub, id, name, hello, match);
        if (match.window) await closeWindow("completed");
        return reply;
      }
      const waiting = pendingPairs.get(id);
      if (waiting) {
        // The same device again while its pairing waits (the app connects afresh for each call): still only the waiting pairing, still nothing enrolled.
        if (!crypto.timingSafeEqual(waiting.pub, pub)) throw new Error("not a paired device");
        return { v: 1, box: { name: boxName() }, pending: id, gate: waiting.gate };
      }
      const row = /** @type {any} */ (db.prepare("SELECT id, pub, kind, paired_at, last_seen FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (!row || !crypto.timingSafeEqual(Buffer.from(row.pub, "base64url"), pub)) {
        // A device the owner removed hears exactly that, on the same code (4401) as when its open channel was
        // closed, so an app can tell "removed" from "box unreachable" and stop retrying (pwa).
        const gone = /** @type {any} */ (db.prepare("SELECT pub FROM relay_devices WHERE id = ? AND removed_at IS NOT NULL").get(id));
        if (gone && crypto.timingSafeEqual(Buffer.from(gone.pub, "base64url"), pub)) throw new Error("device removed");
        throw new Error("not a paired device");
      }
      if (expired(row)) { forget(id, "expired"); throw new Error("this browser went unused too long and was removed; pair it again from another device"); }
      const release = hello && typeof hello.release === "string" && BUILD.test(hello.release) ? hello.release : null;
      const manifest = hello && typeof hello.manifest === "string" && /^[a-f0-9]{64}$/.test(hello.manifest) ? hello.manifest : null;
      if (row.kind === "web") db.prepare("UPDATE relay_devices SET last_seen = ?, release = ?, manifest = ? WHERE id = ?").run(now(), release, manifest, id);
      else db.prepare("UPDATE relay_devices SET last_seen = ? WHERE id = ?").run(now(), id);
      return { v: 1, box: { name: boxName() }, device: id };
    }


    /**
     * Enrols a device that redeemed a ticket: its row, its presence key, the notice and the tailnet grant. Everything a pairing makes happens here and only here, so a gated or
     * windowed ticket makes nothing before it is confirmed. `match` names how the ticket was made (via: start, ring, module, window, gated).
     * @param {Buffer} pub @param {string} id @param {string} name @param {any} hello @param {any} match
     */
    /** The public key a device offered in its hello, by device id, kept briefly so the module that owns the pairing can bind the device's paired session to it when the ticket was not gated (a typed server code). @type {Map<string, { public_key: string, alg: number, storage: string }>} */
    const offeredKeys = new Map();
    async function enrol(pub, id, name, hello, match) {
      // One pairing path (lead ruling, 4 Oct 2026): a browser that completed it, three words confirmed, is one of the person's devices like any other: a row of kind app, whose key is
      // software (WebCrypto). Only the older one-step pairings (the classic QR, no gate) still make a limited `web` row.
      const kind = hello.kind === "web" && !(match && match.gate) ? "web" : "app";
      // A desktop asks to join the tailnet in its pairing hello (ADR 0046 section 3). The grant
      // is what makes a later key possible at all, so it only ever comes from a pairing, which a
      // present person started; a web device never gets one.
      const grant = kind === "app" && hello.tailnet === "join" ? 1 : 0;
      const release = typeof hello.release === "string" && BUILD.test(hello.release) ? hello.release : null;
      const manifest = typeof hello.manifest === "string" && /^[a-f0-9]{64}$/.test(hello.manifest) ? hello.manifest : null;
      let presenceKey = null, presence = { enrolled: false, reason: "no presence key offered" };
      const pk = hello.presenceKey;
      if (pk && typeof pk.public_key === "string") {
        // A Mac server's core takes the app's Secure Enclave key as its Capsule key (`kind: "capsule"`), handed over by a proof the app's setup key signed over the exact name (`core_name`); both are core's to check, here they are only carried.
        const withProof = typeof pk.core_proof === "string" && pk.core_proof && typeof pk.core_name === "string" && pk.core_name;
        const r = await ctx.call("presence.enroll", { kind: withProof && pk.kind === "capsule" ? "capsule" : "device", name: withProof ? pk.core_name : name, public_key: pk.public_key, alg: pk.alg ?? -7, ...(withProof ? { core_proof: pk.core_proof } : {}) });
        if (r && r.data && (r.data.keyId || r.data.id)) {
          presenceKey = String(r.data.keyId || r.data.id); presence = { enrolled: true, reason: "" };
          // kept briefly, for the module that owns the pairing when the ticket was not gated (a server's typed code); a P-256 key only, which is what a paired session binds to
          if (pk.alg === undefined || pk.alg === -7) { offeredKeys.set(id, { public_key: pk.public_key, alg: -7, storage: ["hardware", "software"].includes(pk.storage) ? pk.storage : "unknown" }); if (offeredKeys.size > 64) offeredKeys.delete(offeredKeys.keys().next().value); }
        }
        else presence = { enrolled: false, reason: (r && r.error && r.error.message) || "presence would not enroll this key" };
      }
      const storage = hello.kind === "web" ? "software" : pk && ["hardware", "software"].includes(pk.storage) ? pk.storage : "unknown";
      db.prepare(`INSERT INTO relay_devices (id, name, pub, presence_key, paired_at, last_seen, removed_at, kind, release, manifest, trusted, join_grant, join_mints, join_last, key_storage) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, 0, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, pub = excluded.pub, presence_key = excluded.presence_key, paired_at = excluded.paired_at, last_seen = excluded.last_seen, removed_at = NULL,
          kind = excluded.kind, release = excluded.release, manifest = excluded.manifest, trusted = 0, join_grant = excluded.join_grant, join_mints = 0, join_last = NULL,
          node_id = NULL, node_name = NULL, node_tagged = 0, key_storage = excluded.key_storage`)
        .run(id, name, pub.toString("base64url"), presenceKey, now(), now(), kind, release, manifest, grant, storage);
      // A browser's passkey (ADR 0032 2b), after the three words and in the same step as its row: enrolled bound to THIS device id and to the app's own origin, so it proves for nothing else.
      // A phone keeps its device key above. Offered in the hello as passkey { credential_id, public_key, alg, rp_id }; a refusal leaves the device paired without it and says so in the log.
      const pkey = hello.passkey;
      if (pkey && typeof pkey === "object" && hello.kind === "web" && kind === "app") {
        try {
          const r = /** @type {any} */ (await ctx.call("presence.enroll", { kind: "passkey", name, public_key: String(pkey.public_key || ""), alg: pkey.alg ?? -7, rp_id: String(pkey.rp_id || ""), credential_id: String(pkey.credential_id || ""), device: id }));
          if (r && r.error) ctx.log(`relay: this device's passkey was not enrolled: ${r.error.message || r.error.code}`);
          // a browser has no device key, so its passkey is the row's presence key: removing the device removes it (the existing path), and the list shows presence
          else if (r && r.data && r.data.id && !presenceKey) { presenceKey = String(r.data.id); presence = { enrolled: true, reason: "" }; db.prepare("UPDATE relay_devices SET presence_key = ? WHERE id = ?").run(presenceKey, id); }
        } catch (e) { ctx.log(`relay: this device's passkey was not enrolled: ${/** @type {Error} */ (e).message}`); }
      }
      // The pairing notice: every surface shows it with a one-tap removal (ADR 0026 section 6).
      // Carries the new device's own key fingerprint (reviewer, 28 Sep LOW) so the notice reads
      // the same short form ("a1b2 c3d4") as every other Touch ID / confirm screen that shows one.
      ctx.events.emit("device.paired", { id, name, kind, fingerprint: keyFingerprint(pub), via: String((match && match.via) || "ticket"), ...(match && match.gate ? { gate: match.gate } : {}), ...(kind === "web" ? { release, build: knownBuild(release, manifest) ? "known" : "unknown" } : {}) });
      // The scan-to-pair screen's own event (ADR 0045, the lead 28 Sep): only for a ticket
      // pairing, so a Deck showing "Add your phone" reacts to its own flow and not to someone
      // pairing a different device with the classic QR at the same time.
      if (match.ticket) ctx.events.emit("relay.paired", { device: id, name, fingerprint: keyFingerprint(pub) });
      // A device that asks (hello.enroll) is handed the one-time grant to enroll its passkey at the
      // box's own address: the same grant, and the same {grant, expires, rpId}, as the old setup claim
      // gave the setup QR's phone. Not bound to a peer: at the address the phone is a tailnet node
      // this pairing cannot know; the owner-login rule, the rp_id, five minutes and one use bind it.
      // It rides only inside this device's own Noise channel.
      let enroll = null;
      const host = hello.enroll === true ? addressHost() : null;
      if (host) {
        const m = /** @type {any} */ (await ctx.call("presence.grant.mint", { peer: null, host }));
        if (m && m.data && m.data.grant) enroll = { grant: m.data.grant, expires: m.data.expires, rpId: host };
      }
      return { v: 1, box: { name: boxName() }, device: id, paired: true, presence, ...(enroll ? { enroll } : {}) };
    }

    // ---- gated pairing (X-1, ruling of 4 Oct 2026): nothing exists for a redeemer until the confirm ----
    //
    // A ticket minted with a `gate` (a phone's QR, a server's QR or paste, and a ring ticket once the Wink module has said it confirms with words) is redeemed in two parts. The
    // redemption itself makes NOTHING durable: no device row, no presence key, no bridge session as a device. It leaves a waiting pairing in memory (this map) and the redeemer's
    // channel, whose only door is the one tool its own pairing needs (PENDING_TOOLS) and whose caller is the device id it will have. The module then says yes (relay.pair.pending.confirm,
    // after the person has picked the right words), and only then does `enrol` run: the row, the presence key, the notice. A no, a timeout, or relay.devices.drop makes the waiting pairing
    // vanish: its channels are closed, a reconnect is refused ("not a paired device"), and the ticket, taken at redemption, stays spent.
    const PENDING_MS = seam.pendingMs || 5 * 60_000, PENDING_MAX = 8, PENDING_GRACE_MS = 10_000;
    /** The one tool a waiting pairing may call, by what its ticket was for. A phone and a ring phone ask about the computer's question; a server's scanner completes its own adoption. */
    const PENDING_TOOLS = Object.freeze({ phone: ["wink.phone.wait"], ring: ["wink.phone.wait"], server: ["wink.server.adopt"] });
    /** @type {Map<string, { pub: Buffer, name: string, hello: any, gate: string, match: any, channels: Set<any>, timer: any }>} */
    const pendingPairs = new Map();
    /** A ring ticket (relay.pair.ticket) is always a gated ticket (R-2, 4 Oct 2026): its redeemer is a waiting pairing, and no row, key or session exists for it until the Wink module has had the three words confirmed. It does not depend on that module having registered: with the module down nothing confirms, so nothing pairs. `VYRE_TEST_UNGATED_RING=1` is a test-only switch for relay tests that pair with no module; a packaged daemon ignores it. */
    const ringGated = () => !devSwitch(process.env.VYRE_TEST_UNGATED_RING);
    /** @type {Map<string, any>} */
    const pendingHandlers = new Map();
    const pendingHandler = gate => {
      let h = pendingHandlers.get(gate);
      if (!h) {
        const ok = new Set(PENDING_TOOLS[gate] || []);
        h = ctx.handler({ tool: n => ok.has(n), path: (m, u) => m === "POST" && u.startsWith("/v1/tools/") && ok.has(decodeURIComponent(u.slice("/v1/tools/".length))) });
        pendingHandlers.set(gate, h);
      }
      return h;
    };
    /** Ends a waiting pairing: its channels close and a reconnect finds nothing. @returns {boolean} whether one was waiting */
    // How long a waiting pairing's app may be gone before it is dropped: long enough for a phone on a bad network to reconnect (its client backs off from 1 s), short enough that an abandoned ask does not hold the server for minutes.
    const ABANDON_MS = seam.abandonMs ?? 30_000;
    const pendingDrop = (id, why) => {
      const p = pendingPairs.get(id);
      if (!p) return false;
      pendingPairs.delete(id); clearTimeout(p.timer); clearTimeout(p.gone);
      for (const ch of p.channels) { try { ch.close(4401, why); } catch { /* closed */ } }
      return true;
    };
    function holdPending(pub, id, name, hello, match) {
      if (pendingPairs.size >= PENDING_MAX && !pendingPairs.has(id)) throw new Error("too many pairings are waiting; make a new code in a minute");
      pendingDrop(id, "replaced");
      const keep = { v: 1, ...(hello.kind === "web" ? { kind: "web" } : {}), ...(hello.enroll ? { enroll: hello.enroll } : {}), ...(hello.release ? { release: hello.release } : {}), ...(hello.manifest ? { manifest: hello.manifest } : {}), ...(hello.presenceKey ? { presenceKey: hello.presenceKey } : {}), ...(hello.passkey ? { passkey: hello.passkey } : {}) };
      const p = { pub: Buffer.from(pub), name, hello: keep, gate: String(match.gate), match, channels: new Set(), timer: setTimeout(() => pendingDrop(id, "nobody confirmed this pairing in time"), PENDING_MS) };
      if (p.timer.unref) p.timer.unref();
      pendingPairs.set(id, p);
      ctx.events.emit("pairing.pending", { device: id, name, fingerprint: keyFingerprint(pub), gate: p.gate, via: String(match.via || "ticket") });
      return { v: 1, box: { name: boxName() }, pending: id, gate: p.gate };
    }
    /** The yes: enrol the device now (row, presence key, notice). The waiting channels stay a moment so an answer still in flight reaches the app, then close. */
    const pendingConfirm = async (id, { trusted = false } = {}) => {
      const p = pendingPairs.get(id);
      if (!p) throw fail("not_found", "no pairing is waiting for that device");
      pendingPairs.delete(id); clearTimeout(p.timer);
      try { await enrol(p.pub, id, p.name, p.hello, p.match); }
      catch (e) { for (const ch of p.channels) { try { ch.close(4401, "could not pair"); } catch { /* closed */ } } throw e; }
      // An owner-confirmed phone or computer is trusted from the same moment its row exists (the paired session, ADR 0032 2d): one write, no second step.
      if (trusted) db.prepare("UPDATE relay_devices SET trusted = 1 WHERE id = ? AND removed_at IS NULL").run(id);
      const t = setTimeout(() => { for (const ch of p.channels) { try { ch.close(1000, "paired"); } catch { /* closed */ } } }, PENDING_GRACE_MS);
      if (t.unref) t.unref();
      // The device's own request-signing key, as it offered it in its hello (a public key, SPKI base64url, P-256 alg -7), so the pairing can bind its paired session to it.
      const pk = p.hello && p.hello.presenceKey;
      // `storage` is the app's own report of where it made the key (the platform's key API); it is for display only and no security decision reads it.
      return pk && typeof pk.public_key === "string" ? { key: pk.public_key, alg: pk.alg ?? -7, storage: ["hardware", "software"].includes(pk.storage) ? pk.storage : "unknown", ...(typeof pk.signer === "string" ? { signer: pk.signer.slice(0, 40) } : {}) } : {};
    };

    // ---- the setup session (tailnet plan 3.5, 3.6, 3.6b) ----

    /** @type {SetupSession | null} */
    let setup = null;
    /** Drop every setup device: its row, its presence key, its open channels. Quiet: no notice, since no owner exists to read one. */
    const dropSetupDevices = () => {
      const rows = /** @type {any[]} */ (db.prepare("SELECT id, presence_key FROM relay_devices WHERE kind = 'setup' AND removed_at IS NULL").all());
      for (const r of rows) {
        db.prepare("UPDATE relay_devices SET removed_at = ? WHERE id = ?").run(now(), r.id);
        for (const ch of live.get(r.id) || []) ch.close(4401, "setup ended");
        live.delete(r.id);
        if (r.presence_key) ctx.call("presence.remove", { id: r.presence_key }).catch(() => null);
      }
    };
    /** relay.setup.end's whole job (internal): the claim, the hour, or a newer code ends the session and drops the device, its presence key and its channel. */
    const endSetup = why => { const s = setup; if (!s) { dropSetupDevices(); return false; } return s.end(why); };
    dropSetupDevices();   // a vyred that restarted mid-setup has no session to serve them

    /** @param {Buffer} pub @param {any} hello @param {string} id @param {any} existing */
    async function admitSetup(pub, hello, id, existing) {
      const s = setup;
      if (!s) throw new Error("this is not the setup page for this box");
      if (existing && existing.kind !== "setup") throw new Error("this is not the setup page for this box");
      const spki = s.checkHello({ route: route(), pub, hello });
      // The setup page's powers end where an owner begins (H3): with one, this door is shut.
      if (personExists()) throw new Error("this box already has an owner");
      if (existing) {
        // A reconnect of the device this session admitted: the same Noise key and, again, the page key's signature.
        if (s.device !== id) throw new Error("this is not the setup page for this box");
        return { v: 1, box: { name: boxName() }, device: id, setup: true };
      }
      if (s.device || !s.takeSecret(hello.pair)) throw new Error("this setup code was already used");
      // The page key is this device's presence key, so relay.pair.ticket's prompt can be answered
      // with it, for this session only: relay.setup.end removes it with the device.
      const r = await ctx.call("presence.enroll", { kind: "device", name: "setup page", public_key: spki.toString("base64url"), alg: -7 });
      const keyId = r && r.data && (r.data.keyId || r.data.id);
      if (!keyId) { s.secUsed = false; throw new Error((r && r.error && r.error.message) || "presence would not enroll the setup key"); }
      db.prepare(`INSERT INTO relay_devices (id, name, pub, presence_key, paired_at, last_seen, removed_at, kind, release, manifest, trusted, join_grant, join_mints, join_last) VALUES (?, ?, ?, ?, ?, ?, NULL, 'setup', NULL, NULL, 0, 0, 0, NULL)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, pub = excluded.pub, presence_key = excluded.presence_key, paired_at = excluded.paired_at, last_seen = excluded.last_seen, removed_at = NULL, kind = 'setup'`)
        .run(id, "setup page", pub.toString("base64url"), String(keyId), now(), now());
      s.device = id;
      s.state = "paired";
      ctx.events.emit("setup.paired", { device: id });
      return { v: 1, box: { name: boxName() }, device: id, paired: true, setup: true, presence: { enrolled: true, reason: "" } };
    }

    /**
     * Start a setup session from the code on the install line (VYRE_SETUP_CODE): discard any earlier
     * unclaimed session and its device, register the sealed offer at the code's locator (first
     * writer wins there; a 409 means another server used this code first), and start the hour.
     * @param {string} code
     */
    async function beginSetup(code) {
      const refusal = macCoreRefusal(platform, keys.core);
      if (refusal) throw refusal;
      await keys.ready();
      if (personExists()) throw fail("denied", "this box already has an owner; a setup code does nothing here");
      const s = new SetupSession({ code, now, onEnd: why => {
        if (setup === s) setup = null;
        link?.dropSetup(s.loc);
        dropSetupDevices();
        ctx.events.emit("setup.ended", { why });
      } });
      if (setup) setup.end("replaced");
      dropSetupDevices();
      setup = s;
      if (!settings().enabled) save({ enabled: true });
      startLink();
      await link?.ready();
      const record = ticketSeal(s.secret, JSON.stringify({ v: 1, name: boxName(), handle: boxHandle(), address: addressOrigin(), identity: identityFingerprint(), relay: publishableRelay(settings().url), route: route(), box: k().box.pub.toString("base64url"), exp: s.exp }));
      const mac = ticketMac(s.secret, record);
      const regArgs = { loc: s.loc, record, mac: mac.toString("base64url"), exp: s.exp };
      const status = link ? await link.registerSetup(regArgs) : null;
      s.registered = status === 200;
      if (status === 409 && setup === s) {
        s.state = "contested";
        dropSetupDevices();
        ctx.events.emit("setup.contested", {});
      } else if (link && !s.registered && status !== null) void keepRegistering(s, regArgs, status);
      return setupStatus();
    }

    let stopping = false;
    const nap = (/** @type {number} */ ms) => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
    /** A busy relay (429) or one that is briefly down (5xx, no answer) is "wait a minute", not a refusal: the offer is registered again with a growing pause for as long as the code's hour lasts. @param {any} s @param {any} args @param {number} first */
    async function keepRegistering(s, args, first) {
      if (first === 409 || (first >= 400 && first < 500 && first !== 429 && first !== 408)) return;
      let wait = Number(ctx.config && ctx.config.relay && ctx.config.relay.setupRetryMs) || 3000;
      while (!stopping && setup === s && s.live && !s.registered && s.state !== "contested" && now() < s.exp) {
        await nap(wait); wait = Math.min(wait * 2, 60_000);
        if (stopping || setup !== s) return;
        const st = await link?.registerSetup(args).catch(() => 0);
        s.registered = st === 200;
        if (st === 409 && setup === s) { s.state = "contested"; dropSetupDevices(); ctx.events.emit("setup.contested", {}); return; }
      }
    }
    /** Why the setup code the install line carried was not used (a stamp that is not within the hour, or the relay refusing it): the status says so, so the installer and the person are not left waiting. @type {string | null} */
    let bootSetupFailure = null, bootSetupRetrying = false;
    const setupStatus = () => {
      const s = setup;
      if (!s || !s.live) return bootSetupFailure ? (bootSetupRetrying ? { state: "none", retrying: true, why: bootSetupFailure } : { state: "none", failed: true, why: bootSetupFailure }) : { state: "none" };
      return { state: s.state, registered: s.registered, ticket: s.ticket === "minted", expiresAt: s.exp, ownerExists: personExists(),
        words: s.words(k().box.pub).join(" ") };
    };
    const setupHandler = setupGate({ session: () => setup, extraTools: () => (typeof ctx.declaredSetupTools === "function" ? ctx.declaredSetupTools() : []), ownerExists: personExists, handlerFor: policy => ctx.handler(policy),
      mintTicket: async () => { const refusal = macCoreRefusal(platform, keys.core); if (refusal) throw refusal; return mintTicket(); }, });

    /** The caller label the relay listener hands a paired device, by its kind; null for a kind that may not connect. @param {string} kind @param {string} id */
    const callerLabel = (kind, id) => kind === "app" ? `device:${id}` : kind === "web" ? `web:${id}` : kind === "setup" ? `setup:${id}` : null;
    let handle = null, webHandle = null, upgrade = null;
    function onchannel(channel, { reply }) {
      if (reply && reply.invitee) {
        const door = inviteesFor(ctx);
        if (!door) { channel.close(4401, "this box does not take invitees"); return; }
        const iid = String(reply.invitee);
        // IV-5: invitee channels have a small pool of their own and a life of their own, so a stranger who knows the route can never hold the slots the paired devices need: 8 at a time (the rest are refused at once),
        // closed when no stream opens within 30 s, when the stream they opened has ended (accept or refusal), and after 5 minutes whatever they do.
        if (inviteePool.size >= (seam.inviteePool ?? 8)) { channel.close(4429, "too many invitations are open here; try again in a minute"); return; }
        inviteePool.add(channel);
        let streams = 0, opened = false;
        const timers = /** @type {any[]} */ ([]);
        const stop = () => { for (const t of timers) clearTimeout(t); timers.length = 0; inviteePool.delete(channel); };
        const end = (/** @type {string} */ why) => { stop(); try { channel.close(1000, why); } catch { /* closed */ } };
        const idle = setTimeout(() => { if (!opened) end("no invite stream opened"); }, liveSeam("inviteeIdleMs") ?? 30_000);
        const total = setTimeout(() => end("invite channel time is up"), liveSeam("inviteeTotalMs") ?? 5 * 60_000);
        for (const t of [idle, total]) { if (t.unref) t.unref(); timers.push(t); }
        const prevClose = channel.onclose;
        channel.onclose = (/** @type {any[]} */ ...a) => { stop(); return typeof prevClose === "function" ? prevClose.apply(channel, a) : undefined; };
        // no HTTP-like request reaches anything for an invitee: every one is refused; the one door is the peer stream
        const refuse = (/** @type {any} */ _req, /** @type {any} */ res) => { try { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "denied", message: "an invite opens one door" } })); } catch { /* gone */ } };
        bridge(channel, { handler: refuse, caller: `invitee:${iid}`, peer: { node: "invitee", stableId: iid, login: null, tags: [], caps: {}, kind: "device" }, log: m => ctx.log(m), invitees: door,
          oninvitee: { opened: () => { streams++; opened = true; }, closed: () => { streams = Math.max(0, streams - 1); if (opened && streams === 0) setTimeout(() => end("invite stream ended"), 100).unref?.(); } } });
        return;
      }
      if (reply && reply.home) {
        const door = homesFor(ctx);
        if (!door) { channel.close(4401, "this box does not take homes"); return; }
        const hid = String(reply.home);
        // a stranger home has a small pool of its own, a life of its own (30 s to open the stream, one hour at most) and one door; no HTTP-like request reaches anything
        if (homePool.size >= (seam.homePool ?? 4)) { channel.close(4429, "too many homes are asking; try again in a minute"); return; }
        homePool.add(channel);
        const timers = /** @type {any[]} */ ([]);
        const stop = () => { for (const t of timers) clearTimeout(t); timers.length = 0; homePool.delete(channel); };
        const end = (/** @type {string} */ why) => { stop(); try { channel.close(1000, why); } catch { /* closed */ } };
        let opened = false;
        const idle = setTimeout(() => { if (!opened) end("no pull stream opened"); }, liveSeam("homeIdleMs") ?? 30_000);
        const total = setTimeout(() => end("pull channel time is up"), liveSeam("homeTotalMs") ?? 3_600_000);
        for (const t of [idle, total]) { if (t.unref) t.unref(); timers.push(t); }
        const prevClose = channel.onclose;
        channel.onclose = (/** @type {any[]} */ ...a) => { stop(); return typeof prevClose === "function" ? prevClose.apply(channel, a) : undefined; };
        const refuse = (/** @type {any} */ _req, /** @type {any} */ res) => { try { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "denied", message: "another home opens one door" } })); } catch { /* gone */ } };
        bridge(channel, { handler: refuse, caller: `home:${hid}`, peer: { node: "home", stableId: hid, login: null, tags: [], caps: {}, kind: "device" }, log: m => ctx.log(m), homes: door,
          onhome: { opened: () => { opened = true; }, closed: () => { setTimeout(() => end("pull stream ended"), 100).unref?.(); } } });
        return;
      }
      if (reply && reply.pending) {
        // A waiting pairing (X-1): a channel with one door, the tool its own pairing needs. No device row, no presence key, no upgrade, no peer stream.
        const pid = String(reply.pending), p = pendingPairs.get(pid);
        if (!p) { channel.close(4401, "this pairing is over"); return; }
        const peer = { node: p.name, stableId: pid, login: null, tags: [], caps: {}, kind: "device" };
        // an unconfirmed redeemer is `web:<id>`: it reaches only the tools that name that class (its own pairing's), and becomes `device:<id>` only at the confirm (BR-2)
        bridge(channel, { handler: pendingHandler(p.gate), caller: `web:${pid}`, peer, log: m => ctx.log(m) });
        p.channels.add(channel);
        clearTimeout(p.gone);
        const closed0 = channel.onclose;
        // Every channel of a waiting pairing closed and none came back within the grace: the app is gone (the browser was closed before the yes). The pairing is dropped and the wink module
        // told, so a server does not keep answering "busy" to the next scanner until it restarts.
        channel.onclose = reason => {
          closed0(reason); p.channels.delete(channel);
          if (p.channels.size === 0 && pendingPairs.get(pid) === p) {
            clearTimeout(p.gone);
            p.gone = setTimeout(() => { if (p.channels.size === 0 && pendingPairs.get(pid) === p) { pendingDrop(pid, "abandoned"); try { ctx.events.emit("pairing.abandoned", { device: pid }); } catch { /* no listener */ } } }, ABANDON_MS);
            if (p.gone.unref) p.gone.unref();
          }
        };
        return;
      }
      const id = String(reply.device);
      const row = /** @type {any} */ (db.prepare("SELECT name, kind, trusted FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (!row) { channel.close(4401, "device removed"); return; }
      // A paired SERVER of this home reaching it through the relay (the fallback when the direct path is down): no HTTP-like request reaches anything, and the one door is the peer stream, where
      // the home's door lets it read the network's status and nothing else (core/daemon/peer-door.js acceptServer). Its row's name is its Wink device id.
      if (row.kind === "server") {
        const door = serversFor(ctx);
        if (!door) { channel.close(4401, "this box does not take servers"); return; }
        const refuse = (/** @type {any} */ _req, /** @type {any} */ res) => { try { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "denied", message: "a server opens one door" } })); } catch { /* gone */ } };
        bridge(channel, { handler: refuse, caller: `server:${row.name}`, peer: { node: String(row.name), stableId: id, login: null, tags: [], caps: {}, kind: "device" }, log: m => ctx.log(m),
          peers: { space: door.space, serverId: String(row.name), allow: () => door.isServer(String(row.name)), accept: (/** @type {any} */ stream) => door.acceptServer(stream, { serverId: String(row.name) }) } });
        const set = live.get(id) || new Set();
        set.add(channel); live.set(id, set);
        const closed = channel.onclose;
        channel.onclose = reason => { closed(reason); set.delete(channel); };
        return;
      }
      // The label is the trust claim (BR-2, lead ruling 4 Oct 2026): `device:<id>` only for a live, confirmed device of kind app. A browser is `web:<id>` and a setup page `setup:<id>`,
      // labels the registry never admits as an owner's device, so they reach just the tools that name their class. Any other kind gets no label and no channel.
      const label = callerLabel(row.kind, id);
      if (!label) { channel.close(4401, "this device cannot connect"); return; }
      if (!handle) handle = ctx.handler({});
      if (!webHandle) webHandle = ctx.handler({ tool: name => !WEB_DENY.test(name) });
      const limited = row.kind === "web" && !row.trusted;
      const peer = { node: row.name, stableId: id, login: null, tags: [], caps: {}, kind: "device", ...(row.kind === "web" ? { web: true } : {}) };
      const routed = row.kind === "setup" ? setupHandler : limited ? webHandle : handle;
      const handler = routed;
      const peers = peersFor(ctx);
      bridge(channel, { handler, caller: label, peer, upgrade: () => (upgrade = upgrade || ctx.upgrader({})), log: m => ctx.log(m), ...(peers && !limited ? { peers } : {}) });
      const set = live.get(id) || new Set();
      set.add(channel);
      live.set(id, set);
      const closed = channel.onclose;
      channel.onclose = reason => { closed(reason); set.delete(channel); };
    }

    if (settings().enabled) {
      try { await keys.ready(); startLink(); } catch (e) { ctx.log(`relay: the box keys are not available: ${/** @type {Error} */ (e).message}`); }
    }

    startTunnel().catch(e => ctx.log(`relay: the tunnel link did not start: ${/** @type {Error} */ (e).message}`));
    const offNameA = ctx.events.on("name.claimed", () => { stopTunnel(); startTunnel().catch(() => {}); });
    const offNameB = ctx.events.on("name.released", () => stopTunnel());
    const offDomains = ctx.events.on("appmods.domain-changed", () => { void refreshGate(); });
    // the edge address is a setting a person (or their assistant) changes; the door opens or shuts at once, with no restart
    const offTunnelUrl = ctx.settings.on("relay.tunnel_url", () => { stopTunnel(); startTunnel().catch(() => {}); });

    // ---- tools ----

    /** Where a device is now: connected through the relay, or reporting from its tailnet node lately. */
    const pathOf = d => ((live.get(d.id)?.size || 0) > 0 ? "relay" : d.last_path === "direct" && now() - (d.path_at || 0) < DIRECT_FRESH ? "direct" : null);
    const view = (d, rtt = null, withAsk = false) => ({ id: d.id, name: d.name, kind: d.kind, pairedAt: d.paired_at, lastSeen: d.last_seen, presence: Boolean(d.presence_key),
      online: pathOf(d) !== null, path: pathOf(d), storage: d.key_storage || "unknown", rtt: pathOf(d) === "relay" ? rtt : pathOf(d) === "direct" ? d.rtt : null,
      ...(d.node_id ? { node: d.node_name || d.node_id } : {}),
      ...(d.kind === "web" ? { trusted: Boolean(d.trusted), release: d.release, build: knownBuild(d.release, d.manifest) ? "known" : "unknown",
        expiresAt: (d.last_seen || d.paired_at) + Number(settings().web_expiry_days) * DAY,
        // When this browser asked to be trusted and is still waiting: what a surface reloaded later needs to show the ask again.
        ...(withAsk && d.trust_asked && !d.trusted ? { trustAsked: d.trust_asked, fingerprint: keyFingerprint(Buffer.from(d.pub, "base64url")) } : {}) } : {}) });

    /** Remove a device: close its channels, drop its presence key, tell every surface. */
    function forget(id, why) {
      const row = /** @type {any} */ (db.prepare("SELECT presence_key, node_id, node_tagged FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (!row) return false;
      // Only what the 4401 answer needs stays (the key and the time): the name the person deleted, the presence key id, the build and the path are blanked.
      db.prepare("UPDATE relay_devices SET removed_at = ?, name = '', presence_key = NULL, release = NULL, manifest = NULL, trusted = 0, last_path = NULL, rtt = NULL, join_grant = 0, node_id = NULL, node_name = NULL, node_tagged = 0 WHERE id = ?").run(now(), id);
      for (const ch of live.get(id) || []) ch.close(4401, "device removed");
      live.delete(id);
      if (row.presence_key) ctx.call("presence.remove", { id: row.presence_key }).catch(() => null);
      ctx.events.emit("device.removed", { id, why });
      return true;
    }

    ctx.tool("relay.status", {
      description: "Whether the relay is on and connected, which relay, this box's route id, and how many paired devices and open connections it has.",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta.caller, meta, "the relay's status");
        const s = settings();
        if (s.enabled || await keys.exists()) await keys.ready();
        return { enabled: Boolean(s.enabled), url: s.url, connected: Boolean(link && link.connected), route: s.enabled || keys.loaded ? route() : null,
          devices: active().length, open: link ? link.open : 0, pairing: pairing && pairing.exp > now() ? { expiresAt: pairing.exp } : null,
          // the public door (relay.tunnel_url): off, connecting or live, for the Settings row that says whether people outside can reach signing pages and shared links
          tunnel: { url: tunnelUrl() || null, connected: Boolean(tlink && tlink.connected) } };
      },
    });

    // The same switch for the Wink module, after it has verified an instruction signed by the owner's device key (wink.relay.apply): a headless
    // box has no presence, so the app proves the owner and the box takes the signed word.
    ctx.tool("relay.apply", {
      description: "Turn the relay on at a signed instruction from the owner's app. Only the wink module calls it, after verifying the signature.",
      input: obj({ url: str }),
      run: async (input, meta = {}) => {
        if (meta.caller !== "module:wink") throw fail("denied", "relay.apply is for the wink module");
        const url = input.url ? String(input.url) : settings().url;
        if (!/^wss?:\/\/[^\s/]+/.test(url)) throw fail("bad_input", "url must be a ws:// or wss:// address");
        { const why = relayUrlProblem(url); if (why) throw fail("bad_input", why); }
        if (url !== settings().url) stopLink();
        await keys.ready();
        save({ enabled: true, url });
        startLink();
        return { enabled: true, url };
      },
    });

    ctx.tool("relay.enable", {
      description: "Turn the relay on: the box connects out to the relay so paired devices can reach it from anywhere.",
      input: obj({ url: str }),
      presence: { summary: async () => "Let paired devices reach this box through the relay" },
      run: async (input, meta = {}) => {
        owner(meta.caller, meta, "turning the relay on");
        const url = input.url ? String(input.url) : settings().url;
        if (!/^wss?:\/\/[^\s/]+/.test(url)) throw fail("bad_input", "url must be a ws:// or wss:// address");
        { const why = relayUrlProblem(url); if (why) throw fail("bad_input", why); }
        if (url !== settings().url) stopLink();
        await keys.ready();
        save({ enabled: true, url });
        startLink();
        return { enabled: true, url };
      },
    });

    ctx.tool("relay.disable", {
      description: "Turn the relay off: the box stops connecting out, and every device connected through it is dropped. Paired devices stay paired.",
      input: obj(),
      presence: { summary: async () => "Stop reaching this box through the relay" },
      run: async (_, meta = {}) => {
        owner(meta.caller, meta, "turning the relay off");
        save({ enabled: false });
        stopLink();
        pairing = null;
        return { enabled: false };
      },
    });

    // The code is only useful once the box is at the relay to answer it, so wait for that (a
    // few seconds at most) and say so when it is not there yet.
    const mint = async first => {
      const secret = crypto.randomBytes(16).toString("base64url");
      pairing = { hash: sha(secret), exp: now() + PAIR_TTL, first };
      await keys.ready();
      if (!settings().enabled) save({ enabled: true });
      startLink();
      const connected = link ? await link.ready() : false;
      return { url: pairUrl({ relay: publishableRelay(settings().url), route: route(), box: k().box.pub, secret, name: boxName() }), expiresAt: pairing.exp, connected };
    };

    ctx.tool("relay.pair.start", {
      description: "Make a QR code that pairs one more device with this box through the relay. The code works once, for 10 minutes; making a new one voids the last.",
      input: obj(),
      presence: { summary: async () => "Pair a new device with this box" },
      // The surfaces, the owner's own devices, and a module (onboard runs this step); owner() below refuses a model, an agent, a hook, a guest and anonymous.
      callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "module"],
      run: async (_, meta = {}) => { owner(meta.caller, meta, "pairing a device"); return mint(false); },
    });

    ctx.tool("relay.pair.first", {
      description: "During onboarding only, before this box has any person on a device: make the QR code for the first device. Refused once a device is paired or a tailnet owner exists.",
      input: obj(),
      callers: ["onboard"],
      // No yes is asked here (ruled 10 Oct): before the first device exists no yes can, so a Mac's Touch ID prompt could never be answered by anyone but the process that asks. What guards it instead: only the
      // onboarding page's own caller (a listener behind the one-time setup token, never a label a socket client can claim), and never once any person or owner exists (below).
      run: async () => {
        if (personExists()) throw fail("denied", "this box already has a person on a device; pair more from Settings, Devices");
        return mint(true);
      },
    });

    // Scan-to-pair, "Wink" in copy (ADR 0045): a Vyre code carries only a compact 64-bit ticket,
    // not a full offer, so a phone that scans it resolves the offer from the relay instead of
    // reading it straight off the code. Everything the relay ever sees is a one-way derivation of
    // the ticket under its own tag (core/relay/wire.js): a locator to store the record under, and
    // a MAC key that authenticates it, so the relay can neither redeem the pairing itself (it
    // never learns the secret) nor substitute its own record (it never learns the MAC key), nor
    // read the record (sealed under a fourth derived key, so it holds ciphertext only). The
    // pairing secret this mints is exactly relay.pair.start's own mechanism (`takeLiveSecret`
    // above checks both), so redemption and admission are unchanged.
    /** @param {Buffer} [seed] a ticket the asking app chose itself (relay.pair.ticket { seed }): 8 to 32 bytes it keeps to itself until then */
    /** The last ticket minted: its locator (to withdraw it at the relay) and the key of its pending entry. @type {{ loc: string, key: string } | null} */
    let lastMinted = null;
    /** @param {Buffer | undefined} [seed] @param {{ window?: string, gate?: string, via?: string, offer?: any }} [opt] a ticket minted inside a pairing window carries the window, so its redemption waits for the screen's confirm; a `gate` makes its redemption a waiting pairing (X-1); `via` says which door made it (ring, module, window) for the device.paired event */
    const mintTicket = async (seed, opt = {}) => {
      const rawTicket = seed || crypto.randomBytes(TICKET_BYTES);
      const exp = now() + TICKET_TTL;
      const secret = ticketDerive("sec", rawTicket).toString("base64url");
      pendingTickets.set(sha(secret).toString("hex"), { exp, ...(opt.window ? { window: opt.window } : {}), ...(opt.gate ? { gate: opt.gate } : {}), ...(opt.via ? { via: opt.via } : {}), ...(opt.offer ? { offer: opt.offer } : {}) });
      lastMinted = { loc: ticketDerive("loc", rawTicket).toString("base64url"), key: sha(secret).toString("hex") };
      await keys.ready();
      if (!settings().enabled) save({ enabled: true });
      startLink();
      const connected = link ? await link.ready() : false;
      // Sealed under the ticket's own "enc" key: the relay holds ciphertext only (wire.js).
      // An offer (a Wink invitation: kind, role, projects) rides inside the sealed record only when a module minted the ticket (relay.ticket.mint).
      const record = ticketSeal(rawTicket, JSON.stringify({ v: 1, name: boxName(), handle: boxHandle(), address: addressOrigin(), identity: identityFingerprint(), relay: publishableRelay(settings().url), route: route(), box: k().box.pub.toString("base64url"), exp, ...(opt.offer ? { offer: opt.offer } : {}) }));
      const mac = ticketMac(rawTicket, record);
      let confirmed = false;
      if (link) {
        // The relay's own answer: 200, or 409 when another registration holds this locator (first writer
        // wins there, and a contested locator resolves to nobody). A ticket the app chose itself could
        // collide, so a refusal is a failure here, never a ticket that quietly does not work.
        const status = await link.registerTicket({ loc: ticketDerive("loc", rawTicket).toString("base64url"), record, mac: mac.toString("base64url"), exp });
        if (status === 409) { pendingTickets.delete(sha(secret).toString("hex")); throw fail("conflict", "the relay already holds a ticket with that seed; choose a new one"); }
        // No answer from a relay that never says it answers (the deployed Worker predates the "registered" reply, 30 Sep) is an older relay: it
        // stored the ticket all the same, so it is returned unconfirmed. From a relay that advertises the reply, silence is a failure.
        if (connected && status !== 200 && (status !== null || link.acknowledges())) { pendingTickets.delete(sha(secret).toString("hex")); throw fail("unavailable", status === null ? "the relay did not confirm the ticket; try again" : `the relay refused the ticket (${status}); try again`); }
        confirmed = status === 200;
      }
      // A ticket the app chose is the app's own secret: not echoed back.
      return seed ? { expiresAt: exp, connected, confirmed } : { ticket: rawTicket.toString("base64url"), expiresAt: exp, connected, confirmed };
    };

    // ---- for the wink module (internal: modules only) ----
    ctx.tool("relay.ticket.mint", {
      internal: true,
      description: "A Wink ticket with an offer sealed into its record (an invitation: kind, role, projects), or a ticket from a seed both ends derived (a typed code's key). With `gate` (phone or server) the redemption makes nothing but a waiting pairing until relay.pair.pending.confirm says yes (X-1). Modules only; answers like relay.pair.ticket.",
      input: obj({ seed: str, offer: { type: "object" }, gate: { type: "string", enum: ["phone", "server"] } }),
      run: async input => {
        let seed;
        if (input.seed !== undefined) {
          if (typeof input.seed !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.seed)) throw fail("bad_input", "the seed is base64url");
          seed = Buffer.from(input.seed, "base64url");
          if (seed.length < TICKET_BYTES || seed.length > 32) throw fail("bad_input", `the seed is ${TICKET_BYTES} to 32 bytes`);
        }
        let offer;
        if (input.offer !== undefined) {
          offer = JSON.parse(JSON.stringify(input.offer));
          if (JSON.stringify(offer).length > 2048) throw fail("bad_input", "the offer is at most 2 KB");
        }
        const minted = await mintTicket(seed, { via: "module", ...(offer ? { offer } : {}), ...(input.gate ? { gate: String(input.gate) } : {}) });
        return seed ? { expiresAt: minted.expiresAt, connected: minted.connected, confirmed: minted.confirmed } : minted;
      },
    });
    ctx.tool("relay.code.alloc", {
      internal: true,
      description: "Ask the relay for a free typed-code rendezvous for this box (5 minutes, one at a time). Answers { rv, exp }, or null when the relay is busy, away or has no typed codes. Modules only.",
      input: obj(),
      run: async () => { await keys.ready(); if (!settings().enabled) save({ enabled: true }); startLink(); if (link) await link.ready(); return (link && link.codes() ? await link.codeAlloc() : null); },
    });
    ctx.tool("relay.code.release", {
      internal: true,
      description: "Give the typed-code rendezvous back. Modules only.",
      input: obj(),
      run: async () => { link?.codeRelease(); return { released: true }; },
    });
    ctx.tool("relay.code.reply", {
      internal: true,
      description: "Answer a typed code's message (the relay.code-asked event): q is its id, m the reply in base64url, or none to refuse. Modules only.",
      input: obj({ q: str, m: str }, ["q"]),
      run: async input => { link?.codeReply(String(input.q), typeof input.m === "string" ? input.m : null); return { sent: true }; },
    });

    ctx.tool("relay.pair.ticket", {
      description: "Mint a one-time pairing ticket for the Vyre code (Wink): a phone that scans it resolves the box's identity from the relay, then pairs exactly as relay.pair.start's QR does. Works once, for 5 minutes; call again for a fresh one (an old, unused ticket is simply left to expire, unlike relay.pair.start's single live QR). Not available on a Mac yet: see vyre-core (ADR 0040).",
      input: obj({ seed: str }),
      presence: { when: () => !macCoreRefusal(platform, keys.core), summary: async i => i && i.seed ? "Let the Windows PC that shows this code join this box" : `Pair a new device with this box, by scanning its Vyre code${settings().enabled ? "" : " (this also turns the relay on)"}` },
      run: async (input, meta = {}) => {
        const refusal = macCoreRefusal(platform, keys.core);
        if (refusal) throw refusal;
        owner(meta.caller, meta, "pairing a device");
        // A computer that asks to be added (Windows) chose its ticket itself and shows it to the person:
        // the box only registers it, so the app already holds it and needs nothing sent back.
        let seed;
        if (input && input.seed !== undefined) {
          if (typeof input.seed !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.seed)) throw fail("bad_input", "the seed is base64url");
          seed = Buffer.from(input.seed, "base64url");
          if (seed.length < TICKET_BYTES || seed.length > 32) throw fail("bad_input", `the seed is ${TICKET_BYTES} to 32 bytes`);
        }
        // The ring: a ticket that pairs whoever redeems it is a pairing nobody confirmed. Once the Wink module confirms with words, a ring ticket is gated like the others.
        return mintTicket(seed, { via: "ring", ...(ringGated() ? { gate: "ring" } : {}) });
      },
    });
    ctx.tool("relay.pair.pending.confirm", {
      internal: true,
      description: "The yes for a waiting pairing (a gated ticket, X-1): enrols the device that redeemed it, now. Only the Wink module, which has had the person pick the right three words. With `trusted` the device is marked trusted at the same moment (an owner-confirmed phone or computer). Answers { paired, id, key?, alg? }: the public key the device offered in its hello, so the pairing can bind its session to it.",
      input: obj({ id: str, trusted: { type: "boolean" } }, ["id"]),
      run: async (input, meta = {}) => {
        if (meta.caller !== "module:wink") throw fail("denied", "only the Wink module confirms a waiting pairing");
        const k = await pendingConfirm(String(input.id), { trusted: input.trusted === true });
        return { paired: true, id: String(input.id), ...(k || {}) };
      },
    });

    // ---- the pairing window: one proof opens up to 10 minutes of renewing the Wink code, then the screen confirms the phone ----
    //
    // Opening needs the person's proof once. After that the open screen renews the code (each renewal withdraws the
    // previous ticket at the relay first, so at most one is ever live) without a new prompt, but only the same screen
    // (same caller and node), only while it keeps pinging, and only up to the limits below. When a phone redeems, nothing is
    // enrolled until the screen confirms that phone by its fingerprint. All in memory: a restart ends the window.
    const WINDOW_MS = 10 * 60_000, PING_EVERY = 15_000, SILENCE_MS = 30_000, RENEW_EVERY = 15_000, RENEW_MAX = 40, CONFIRM_MS = 60_000;
    /** @type {null | { id: string, who: string, closesAt: number, lastPing: number, lastRenew: number, renewals: number, live: { loc: string, key: string } | null, pending: null | { device: string, resolve: (ok: boolean) => void }, purpose: string, boxName: string }} */
    let pairWindow = null;
    /** @type {any} */
    let windowTimer = null;
    /** Who opened it: the caller, the node, and the person session. A renewal must come from all three. Opening needs a proof, and a proof from
     * an owner's device needs a person session, so the session part is never empty for an open window (a test pins it). */
    const windowWho = meta => `${String((meta && meta.caller) || "")}|${(meta && meta.peer && (meta.peer.stableId || meta.peer.node)) || ""}|${(meta && meta.person && meta.person.id) || ""}`;
    /** The window's screen: the owner's own device or browser, never a terminal, an agent or a module. */
    const screenOnly = (meta, what) => {
      const c = String((meta && meta.caller) || "");
      if (!ownerDevice(c) || agentClaim(c) || (meta && meta.agent)) throw fail("denied", `${what} is for the owner's own screen, never a terminal, an agent or a module`);
    };
    const theWindow = (meta, id) => {
      screenOnly(meta, "the pairing window");
      const w = pairWindow;
      if (!w || w.id !== String(id)) throw fail("not_found", "no such pairing window: it has closed");
      if (windowWho(meta) !== w.who) throw fail("denied", "only the screen that opened the pairing window may use it");
      return w;
    };
    const withdrawLive = async w => {
      if (!w.live) return;
      const live = w.live; w.live = null;
      pendingTickets.delete(live.key);
      if (link && link.revokes()) await link.revokeTicket(live.loc);
    };
    const closeWindow = async reason => {
      const w = pairWindow;
      if (!w) return;
      pairWindow = null;
      clearInterval(windowTimer); windowTimer = null;
      if (w.pending) w.pending.resolve(false);
      await withdrawLive(w);
      ctx.events.emit("pairing-window.closed", { window: w.id, reason });
    };
    const holdForConfirm = async (windowId, pub, name) => {
      const w = pairWindow;
      if (!w || w.id !== windowId) throw new Error("the pairing window has closed; make a new code");
      if (w.pending) throw new Error("another phone is already waiting to be confirmed");
      const device = deviceId(pub);
      const done = new Promise(resolve => { w.pending = { device, resolve }; });
      ctx.events.emit("pairing.requested", { window: w.id, device, name, fingerprint: keyFingerprint(pub) });
      const ok = await within(done, CONFIRM_MS, false);
      if (w.pending && w.pending.device === device) w.pending = null;
      if (!ok) throw new Error("the box did not confirm this phone");
    };
    const mintInWindow = async w => {
      const minted = await mintTicket(undefined, { window: w.id });
      w.live = lastMinted;
      ctx.events.emit("pairing-window.renewed", { window: w.id });
      return { ticket: minted.ticket, ticketExpiresAt: minted.expiresAt, confirmed: minted.confirmed };
    };

    ctx.tool("relay.pair.window.open", {
      callers: ["deck", "tailnet"],
      description: "Open a pairing window on this screen: one proof, then up to 10 minutes of Wink codes this screen may renew without another prompt (relay.pair.window.renew). Answers { window, closesAt, pingEveryMs, ticket, ticketExpiresAt }. The window is for pair.device on this box only. A phone that redeems a code is enrolled only after relay.pair.window.confirm.",
      input: obj(),
      presence: { when: () => !macCoreRefusal(platform, keys.core), summary: async () => "Let this screen show a code that adds a phone to this box, for up to 10 minutes" },
      run: async (_, meta = {}) => {
        const refusal = macCoreRefusal(platform, keys.core);
        if (refusal) throw refusal;
        screenOnly(meta, "opening the pairing window");
        await closeWindow("replaced");
        const t = now();
        const w = { id: crypto.randomBytes(12).toString("base64url"), who: windowWho(meta), closesAt: t + WINDOW_MS, lastPing: t, lastRenew: t, renewals: 0, live: null, pending: null, purpose: "pair.device", boxName: boxName() };
        pairWindow = w;
        windowTimer = setInterval(() => {
          const n = now();
          if (pairWindow !== w) return;
          if (n - w.lastPing > SILENCE_MS) closeWindow("silence"); else if (n >= w.closesAt) closeWindow("expired");
        }, 5000);
        windowTimer.unref?.();
        ctx.events.emit("pairing-window.opened", { window: w.id });
        const m = await mintInWindow(w);
        return { window: w.id, closesAt: w.closesAt, pingEveryMs: PING_EVERY, ...m };
      },
    });

    ctx.tool("relay.pair.window.renew", {
      callers: ["deck", "tailnet"],
      description: "Renew the Wink code inside an open pairing window, with no new proof. It withdraws the previous code at the relay first, so one is ever live. Only the screen that opened the window, while it keeps pinging; at most one every 15 seconds and 40 in a window. Answers { ticket, ticketExpiresAt }.",
      input: obj({ window: str }, ["window"]),
      run: async (input, meta = {}) => {
        const w = theWindow(meta, input.window);
        const n = now();
        if (n - w.lastPing > SILENCE_MS) { await closeWindow("silence"); throw fail("denied", "the pairing window closed: the screen stopped pinging"); }
        if (n >= w.closesAt) { await closeWindow("expired"); throw fail("denied", "the pairing window has expired"); }
        if (n - w.lastRenew < RENEW_EVERY) throw fail("rate_limited", "a code can be renewed once every 15 seconds");
        if (w.renewals >= RENEW_MAX) { await closeWindow("renewals"); throw fail("rate_limited", "this pairing window has used its renewals"); }
        w.lastRenew = n; w.lastPing = n; w.renewals++;
        await withdrawLive(w);
        return mintInWindow(w);
      },
    });

    ctx.tool("relay.pair.window.ping", {
      callers: ["deck", "tailnet"],
      description: "The open screen's heartbeat for its pairing window, every 15 seconds. The window closes after 30 seconds of silence. Answers { closesInMs }.",
      input: obj({ window: str }, ["window"]),
      run: async (input, meta = {}) => {
        const w = theWindow(meta, input.window);
        w.lastPing = now();
        return { closesInMs: Math.max(0, w.closesAt - now()) };
      },
    });

    ctx.tool("relay.pair.window.close", {
      callers: ["deck", "tailnet"],
      description: "Close the pairing window: the live code is withdrawn at the relay.",
      input: obj({ window: str }, ["window"]),
      run: async (input, meta = {}) => { theWindow(meta, input.window); await closeWindow("closed by the screen"); return { closed: true }; },
    });

    ctx.tool("relay.pair.window.confirm", {
      callers: ["deck", "tailnet"],
      description: "The person confirms the phone that is pairing (shown as pairing.requested, with its name and key fingerprint). Only then is it enrolled, and the window closes. Answers { confirmed: true }.",
      input: obj({ window: str, device: str }, ["window", "device"]),
      run: async (input, meta = {}) => {
        const w = theWindow(meta, input.window);
        if (!w.pending || w.pending.device !== String(input.device)) throw fail("not_found", "no phone is waiting to be confirmed with that id");
        w.pending.resolve(true);
        return { confirmed: true };
      },
    });

    ctx.tool("relay.pair.window.reject", {
      callers: ["deck", "tailnet"],
      description: "\"Not you?\": refuse the phone that is waiting to be confirmed, shown as pairing.requested. The window stays open and the slot is free at once, so a stranger who redeemed a code cannot hold it; the screen renews the code for the real phone. Answers { rejected: true }.",
      input: obj({ window: str, device: str }, ["window", "device"]),
      run: async (input, meta = {}) => {
        const w = theWindow(meta, input.window);
        if (!w.pending || w.pending.device !== String(input.device)) throw fail("not_found", "no phone is waiting to be confirmed with that id");
        const p = w.pending; w.pending = null; p.resolve(false);
        ctx.events.emit("pairing.rejected", { window: w.id, device: p.device });
        return { rejected: true };
      },
    });

    // A short fingerprint for the Touch ID prompt: the box's key, never the relay it happens to
    // sit behind. Same shape as core/relay's own device ids (base32 of sha256), just short enough
    // to read: 8 characters as two groups of 4.
    const keyFingerprint = box => { const s = base32(crypto.createHash("sha256").update(box).digest()).slice(0, 8); return `${s.slice(0, 4)} ${s.slice(4)}`; };

    ctx.tool("relay.join", {
      description: "This Vyre becomes a device of another box, redeeming a one-time pairing code minted there (relay.pair.start or onboard.join{action:\"relay\"}). One redemption: the channel closes once paired, then this tool returns what the other box said (its name, this device's id, whether presence enrolled). becomeDevice, when true, flips this machine to \"device\" once paired (onboard.machine): the same flag onboard.join{action:\"verify\",becomeDevice} takes. Does not keep a connection open; that is not built yet. A pasted URL that is not a real Vyre pairing code is refused before any prompt. Not available on a Mac yet: see vyre-core (ADR 0040).",
      input: obj({ url: { type: "string", pattern: "^https://vyre\\.run/pair#[A-Za-z0-9_-]+$" }, name: str, becomeDevice: { type: "boolean" } }, ["url"]),
      callers: ["cli", "local", "deck", "capsule"],
      // On darwin this always refuses (see macCoreRefusal above), so presence is not required
      // there either: no Touch ID prompt for a call that can only ever fail.
      presence: {
        when: () => !macCoreRefusal(platform, keys.core),
        summary: async i => {
          const offer = parsePairUrl(i && i.url);
          if (!offer) return "This does not look like a real Vyre pairing code; refusing to pair.";
          const host = promptSafe((offer.relay.match(/^wss?:\/\/([^/]+)/) || [])[1] || offer.relay, "a relay", 64);
          // The name is the OTHER box's own text; the key shown after it is always this box's own
          // computed fingerprint, never anything the other side sent.
          const name = promptSafe(offer.name, "a Vyre box");
          return `Pair this device with "${name}" on ${host} (key ${keyFingerprint(offer.box)})`;
        },
      },
      run: async ({ url, name, becomeDevice = false }, meta = {}) => {
        const refusal = macCoreRefusal(platform, keys.core);
        if (refusal) throw refusal;
        owner(meta.caller, meta, "joining another box");
        if (!parsePairUrl(url)) throw fail("bad_input", "that does not look like a real Vyre pairing code");
        let paired;
        try { paired = await redeem(url, { root: ctx.paths.root, name, coreKeys: keys.client }); }
        catch (e) { throw fail("bad_input", /** @type {Error} */ (e).message); }
        if (becomeDevice) await ctx.call("onboard.machine", { machine: "device" }).catch(() => {});
        return paired;
      },
    });

    // The paired devices for other modules (VyreDrop asks which of the person's computers exist and which are connected): id, name, kind and whether connected now. Nothing else, and no web browser's row.
    ctx.tool("relay.devices.all", {
      description: "The paired computers and phones, for a module: id, name, kind and whether each is connected now.",
      input: obj(),
      run: async (_, meta = {}) => {
        if (!String((meta && meta.caller) || "").startsWith("module:")) throw Object.assign(new Error("for modules; relay.status shows the relay and how many devices are paired"), { code: "denied" });
        return { devices: active().filter((/** @type {any} */ d) => d.kind !== "web").map((/** @type {any} */ d) => { const v = view(d, null, false); return { id: v.id, name: v.name, kind: d.kind, online: Boolean(v.online) }; }) };
      },
    });
    ctx.tool("relay.devices.list", {
      callers: ["web"],
      description: "Devices paired through the relay: id, name, when paired and last seen, whether presence is enrolled, and whether it is connected now.",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta.caller, meta, "the device list");
        for (const d of active()) if (expired(d)) forget(d.id, "expired");
        const rows = active();
        // The relay round trip, measured now over each open channel (1 s at most, never on a timer).
        const rtts = await Promise.all(rows.map(async d => {
          const chans = [...(live.get(d.id) || [])];
          return chans.length ? chans[chans.length - 1].ping(1000) : null;
        }));
        // A limited browser (a web device not yet trusted) sees the list but not who else is waiting to be trusted.
        const c = String((meta && meta.caller) || "");
        const me = /^(device|web|setup):/.test(c) ? /** @type {any} */ (db.prepare("SELECT kind, trusted FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(c.slice(c.indexOf(":") + 1))) : null;
        const withAsk = !(me && me.kind === "web" && !me.trusted);
        // A legacy browser (kind web) reads its own row only: names, last seen and presence of the other devices are not its to see (reviewer-3 PA-4).
        const mine = c.startsWith("web:") ? c.slice(4) : null;
        return { devices: rows.map((d, i) => view(d, rtts[i], withAsk)).filter(d => mine === null || d.id === mine) };
      },
    });

    ctx.tool("relay.devices.rename", {
      description: "Rename a paired device.",
      input: obj({ id: str, name: str }, ["id", "name"]),
      run: async (input, meta = {}) => {
        owner(meta.caller, meta, "renaming a device");
        const name = cleanLabel(input.name);
        if (!NAME.test(name)) throw fail("bad_input", "a name is 1 to 64 printable characters");
        const r = db.prepare("UPDATE relay_devices SET name = ? WHERE id = ? AND removed_at IS NULL").run(name, String(input.id));
        if (!r.changes) throw fail("not_found", `no paired device ${input.id}`);
        ctx.events.emit("device.renamed", { kind: "relay", id: String(input.id), name });
        return { id: String(input.id), name };
      },
    });

    ctx.tool("relay.devices.remove", {
      description: "Remove a paired device: its connections close at once and it can no longer reach the box through the relay. Its presence key is removed too.",
      input: obj({ id: str }, ["id"]),
      presence: { summary: async input => `Remove device ${String(input && input.id)} from this box` },
      run: async (input, meta = {}) => {
        owner(meta.caller, meta, "removing a device");
        const id = String(input.id);
        if (!forget(id, "removed")) throw fail("not_found", `no paired device ${id}`);
        return { removed: id };
      },
    });

    // The same removal for another module (wink: one removal of a device closes its connections). It needs no person: the module already holds the owner's say.
    ctx.tool("relay.devices.drop", {
      description: "Close a paired device's connections and refuse it from now on, for a module that has just removed it for the owner.",
      input: obj({ id: str }, ["id"]),
      run: async (input, meta = {}) => {
        if (meta.caller !== "module:wink") throw Object.assign(new Error("only the Wink module closes a paired device's connections"), { code: "denied" });
        const id = String(input.id);
        // a pairing still waiting for its confirm is let go the same way: its channels close and nothing was ever made
        const waited = pendingDrop(id, "removed");
        return { closed: forget(id, "removed") || waited, id };
      },
    });

    ctx.tool("relay.devices.clear-leftover", {
      description: "On a server nobody owns: let go of every paired device row left by a pairing that never completed ownership, so a new owner's pairing is not refused by them. Only the Wink module asks, and only while the server is unowned. Answers { cleared }.",
      input: obj(),
      run: async (_i, meta = {}) => {
        if (meta.caller !== "module:wink") throw Object.assign(new Error("only the Wink module clears leftover devices"), { code: "denied" });
        // the relay asks for itself: a server that is owned never lets go of anything here
        const st = /** @type {any} */ (await ctx.call("wink.server.owned", {}).catch(() => null));
        if (!st || st.error || !st.data || st.data.owned !== false) throw Object.assign(new Error("this server is owned (or its owner cannot be read): leftover devices stay"), { code: "owned" });
        let n = 0;
        for (const d of active()) if (d.kind === "app" || d.kind === "web") { if (forget(String(d.id), "removed")) n++; }
        if (n) ctx.log(`relay: let go of ${n} leftover device(s) of a pairing that never completed ownership`);
        return { cleared: n };
      },
    });

    // The hosted app's loader asks which build to load (ADR 0026 section 10, ADR 0027 section 4):
    // the owner's pin, or the newest release this box ships knowing. Open to any paired device,
    // web ones included, since the loader must ask before it can load anything else.
    ctx.tool("relay.web.release", {
      callers: ["web"],
      description: "Which build of the hosted web app this box trusts: its release, the content-addressed folder sha and the manifest hash the loader must check. The owner's pin, or the newest release this box knows.",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta.caller, meta, "the web app's release");
        const pin = settings().web_pin;
        const r = (pin && findRelease(pin)) || newestRelease();
        if (!r) throw fail("not_found", "this box knows no release of the web app yet");
        return { release: r.release, sha: r.sha, manifest: r.manifest, path: `/v/${r.sha}/`, pinned: Boolean(pin && findRelease(pin)) };
      },
    });

    ctx.tool("relay.web.pin", {
      description: "Pin the hosted web app to one release this box knows, or clear the pin (empty release) to follow the newest one.",
      input: obj({ release: str }, ["release"]),
      presence: { summary: async input => (input && input.release ? `Pin the web app to release ${input.release}` : "Let the web app follow the newest release") },
      run: async (input, meta = {}) => {
        owner(meta.caller, meta, "pinning the web app");
        const release = String(input.release || "");
        if (release && !findRelease(release)) throw fail("bad_input", `this box does not know web app release ${release}`);
        save({ web_pin: release || null });
        return { pinned: release || null };
      },
    });

    /** Record where a device is, and tell the surfaces when that changed. */
    function moved(id, path, rtt) {
      const row = /** @type {any} */ (db.prepare("SELECT last_path FROM relay_devices WHERE id = ?").get(id));
      db.prepare("UPDATE relay_devices SET last_path = ?, path_at = ?, rtt = ? WHERE id = ?").run(path, now(), rtt, id);
      if (!row || row.last_path !== path) ctx.events.emit("device.moved", { id, path, ...(rtt !== null ? { rtt } : {}) });
    }
    /** One-time codes that let a device name its tailnet node: device id -> { hash, exp }. */
    const linking = new Map();

    // A device's app reports its path when it switches (ADR 0029, R5). Over the relay it is
    // device:<id>, and gets a one-time code. Over the tailnet it is its node (whois); the first time,
    // it hands the code back so the box learns which node that device is. After that, a report
    // from that node is that device on the direct path.
    ctx.tool("relay.devices.path", {
      description: "A paired device says which way it reaches the box now (relay or direct over the tailnet) and its measured round trip. Over the tailnet the first report carries the device id and the one-time code the relay path gave it, which links the device to its tailnet node.",
      input: obj({ path: { type: "string", enum: ["relay", "direct"] }, rtt: { type: "number" }, id: str, code: str }, ["path"]),
      run: async (input, meta = {}) => {
        owner(meta.caller, meta, "a device's path");
        const c = String(meta.caller || "");
        const rtt = Number.isFinite(input.rtt) && input.rtt >= 0 && input.rtt < 60_000 ? Math.round(input.rtt) : null;
        const callerDevice = deviceIdOf(c);
        if (callerDevice !== null) {
          const id = callerDevice;
          if (input.path !== "relay") throw fail("bad_input", "through the relay, a device reports the relay path");
          moved(id, "relay", rtt);
          const code = crypto.randomBytes(16).toString("base64url");
          linking.set(id, { hash: sha(code), exp: now() + LINK_TTL });
          return { path: "relay", link: code };
        }
        throw fail("denied", "only a paired device, over the relay, reports a path");
      },
    });

    // For presence.person.start (ADR 0032): the presence key this box enrolled when it paired a
    // device, so a relayed device signs in only with its own key. Modules only; null for a device
    // that is removed, unknown or paired without one.
    // For the move engine's ownedNode/openPeer seams (ADR 0042, federation): the one thing that
    // proves "this id is one of the owner's own paired nodes" without re-deriving identity from
    // the network. stableId/staticKey are this pairing's own Noise identity (ADR 0026), never a
    // tailnet stable id; `node` is only ever filled once this device has ALSO reported itself over
    // its own tailnet node (relay.devices.path, already built, no dependency on ADR 0046's
    // auth-key auto-join), the same node_id/node_name columns that already exist for exactly this
    // purpose. Module-only: never a tool a person, an agent or a relayed device calls directly.
    ctx.tool("relay.devices.node", {
      internal: true,
      description: "A paired relay device's own Noise identity and, if it has reported one, its tailnet node, for a module to check ownership or open a direct connection, never for a person or a device to call about itself.",
      input: obj({ id: str }, ["id"]),
      run: async input => {
        const row = /** @type {any} */ (db.prepare("SELECT id, name, pub, node_id, node_name FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(String(input.id)));
        if (!row) return { stableId: null, staticKey: null, name: null, node: null };
        return { stableId: row.id, staticKey: row.pub, name: row.name, node: row.node_id ? { stableId: row.node_id, name: row.node_name || null } : null };
      },
    });

    ctx.tool("relay.device.info", {
      internal: true,
      description: "A paired relay device as the link module's companion check needs it: kind, trusted, when it paired, its presence key id and whether it was removed. Null for an id never paired. Modules only.",
      input: obj({ id: str }, ["id"]),
      run: async input => {
        const row = /** @type {any} */ (db.prepare("SELECT kind, trusted, paired_at, presence_key, removed_at FROM relay_devices WHERE id = ?").get(String(input.id)));
        return row ? { kind: row.kind, trusted: Boolean(row.trusted), pairedAt: row.paired_at, presenceKey: row.presence_key || null, removed: row.removed_at !== null && row.removed_at !== undefined } : null;
      },
    });

    // A paired server's row, made by the wink module when it hands a server what it needs to reach this home. The server's key is derived from the peer secret both sides hold, so the home
    // names the public half itself (nothing comes from the server); the row is of kind "server", which the device list never shows and which may open only the server door.
    ctx.tool("relay.devices.admit-server", {
      internal: true,
      description: "Admit a paired server's relay key as a row of kind server (never an app device): it may open one peer stream, and the home's door lets it read the network's status. `pub` is the 32-byte key, base64url; `server` is its Wink device id. Modules only. Answers { id }.",
      input: obj({ pub: str, server: str }, ["pub", "server"]),
      run: async input => {
        const pub = Buffer.from(String(input.pub), "base64url");
        if (pub.length !== 32) throw fail("bad_input", "a relay key is 32 bytes");
        const server = String(input.server);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(server)) throw fail("bad_input", "a server id is letters, digits, - and _");
        const id = deviceId(pub);
        const existing = /** @type {any} */ (db.prepare("SELECT kind FROM relay_devices WHERE id = ?").get(id));
        if (existing && existing.kind !== "server") throw fail("conflict", "that key is a device here already");
        db.prepare(`INSERT INTO relay_devices (id, name, pub, presence_key, paired_at, last_seen, removed_at, kind, release, manifest, trusted, join_grant, join_mints, join_last) VALUES (?, ?, ?, NULL, ?, ?, NULL, 'server', NULL, NULL, 0, 0, 0, NULL)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, pub = excluded.pub, removed_at = NULL, kind = 'server'`).run(id, server, pub.toString("base64url"), now(), now());
        return { id };
      },
    });
    ctx.tool("relay.devices.drop-server", {
      internal: true,
      description: "Take a paired server's relay row away and close its channels. Modules only. Answers { dropped }.",
      input: obj({ server: str }, ["server"]),
      run: async input => {
        const rows = /** @type {any[]} */ (db.prepare("SELECT id FROM relay_devices WHERE kind = 'server' AND name = ? AND removed_at IS NULL").all(String(input.server)));
        for (const r of rows) {
          db.prepare("UPDATE relay_devices SET removed_at = ?, name = '' WHERE id = ?").run(now(), r.id);
          for (const ch of live.get(r.id) || []) ch.close(4401, "device removed");
          live.delete(r.id);
        }
        return { dropped: rows.length };
      },
    });

    ctx.tool("relay.device.presence", {
      internal: true,
      description: "The presence key id enrolled for a paired relay device, or null.",
      input: obj({ id: str }, ["id"]),
      run: async input => {
        const row = /** @type {any} */ (db.prepare("SELECT presence_key FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(String(input.id)));
        return { key: (row && row.presence_key) || null, ...(row && offeredKeys.get(String(input.id)) ? offeredKeys.get(String(input.id)) : {}) };
      },
    });

    ctx.tool("relay.devices.ask-trust", {
      callers: ["web"],
      description: "A browser paired from the hosted web app asks the owner to trust it fully. Only that browser, about itself; it tells every surface once (device.trust-asked) and the owner's own relay.devices.trust, with presence, is the approval.",
      input: obj(),
      run: async (_, meta = {}) => {
        const c = String((meta && meta.caller) || "");
        if (!c.startsWith("web:") || agentClaim(c) || (meta && meta.agent)) throw fail("denied", "only a paired browser can ask to be trusted, about itself");
        const id = c.slice("web:".length);
        const row = /** @type {any} */ (db.prepare("SELECT id, name, kind, pub, trusted, trust_asked FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
        if (!row) throw fail("not_found", "this browser is not paired");
        if (row.kind !== "web") throw fail("bad_input", "only a browser from the web app has limits to lift");
        if (row.trusted) return { id, trusted: true, asked: false };
        if (row.trust_asked) return { id, trusted: false, asked: true, already: true };
        db.prepare("UPDATE relay_devices SET trust_asked = ? WHERE id = ?").run(now(), id);
        ctx.events.emit("device.trust-asked", { id, name: row.name, fingerprint: keyFingerprint(Buffer.from(row.pub, "base64url")) });
        return { id, trusted: false, asked: true, already: false };
      },
    });

    ctx.tool("relay.devices.trust", {
      description: "Give a browser paired from the hosted web app the full powers of the owner's app (pairing devices, vault secrets), or take them back. Not callable from a web device that is not trusted.",
      input: obj({ id: str, trusted: { type: "boolean" } }, ["id", "trusted"]),
      presence: { summary: async input => `${input && input.trusted ? "Trust" : "Stop trusting"} browser ${String(input && input.id)} fully` },
      run: async (input, meta = {}) => {
        owner(meta.caller, meta, "trusting a browser");
        const id = String(input.id);
        const row = /** @type {any} */ (db.prepare("SELECT kind FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
        if (!row) throw fail("not_found", `no paired device ${id}`);
        if (row.kind !== "web") throw fail("bad_input", "only a browser from the web app has limits to lift");
        db.prepare("UPDATE relay_devices SET trusted = ?, trust_asked = NULL WHERE id = ?").run(input.trusted ? 1 : 0, id);
        // Open channels keep the handler they started with: close them so the next one gets the new one.
        for (const ch of live.get(id) || []) ch.close(1000, "trust changed");
        live.delete(id);
        return { id, trusted: Boolean(input.trusted) };
      },
    });

    // The setup session's tools (tailnet plan 3.6b). begin and end are modules-only: the install's
    // own boot (VYRE_SETUP_CODE, below) and the claim (launch) call them, never a person, a model or a
    // channel. status is the one a setup channel may call, and the install script reads it too.
    // Internal is "a module", not "this module": name the modules that may call each one.
    const only = (/** @type {any} */ meta, /** @type {string[]} */ names, /** @type {string} */ what) => {
      if (!names.some(n => String((meta && meta.caller) || "") === `module:${n}`)) throw fail("denied", `${what} is not available to this caller`);
    };

    ctx.tool("relay.setup.begin", {
      internal: true,
      description: "Start a setup session from the code on the install line: register the sealed offer at the relay, discard any earlier unclaimed setup session and its device, and start the hour. Modules only.",
      input: obj({ code: str }, ["code"]),
      run: async (input, meta) => { only(meta, ["onboard", "launch"], "starting a setup session"); return beginSetup(String(input.code || "")); },
    });

    ctx.tool("relay.setup.end", {
      internal: true,
      description: "End the setup session: drop the setup device, its presence key and its channel. Called at the claim, and by the session itself when its hour runs out with no claim. Modules only, never callable through the setup channel.",
      input: obj({ reason: str }),
      run: async (input, meta) => { only(meta, ["onboard", "launch", "names"], "ending the setup session"); return { ended: endSetup(String(input.reason || "claimed").slice(0, 40)) }; },
    });

    ctx.tool("relay.setup.status", {
      // the four check words of a pairing in progress: the person's surfaces, the owner's devices (the setup page) and modules; never a model session
      callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module"],
      description: "Where the setup session is: none, waiting for the page, paired, or contested (another server used the code first), whether the relay holds the offer, whether the one pairing ticket is made, when the hour ends, and the four check words the page shows too.",
      input: obj(),
      run: async (_, meta = {}) => { owner(meta.caller, meta, "the setup status"); return setupStatus(); },
    });

    // The route key's two calls for the names directory (core/names cannot import this module).
    // Modules only. sign refuses any message that does not open with the names tag and this box's
    // own route, so the key is never a general signing oracle (the relay's own box-auth message
    // does not begin that way).
    ctx.tool("relay.route.id", {
      internal: true,
      description: "This box's route id and route public key (base64url), for signing into the name directory, and the box's own public key (`box`), which the Wink module hashes into the words a pairing shows. Modules only.",
      input: obj(),
      run: async (_, meta) => { only(meta, ["names", "wink", "vyred"], "the route id"); await keys.ready(); return { route: route(), pub: Buffer.from(k().route.pub).toString("base64url"), box: Buffer.from(k().box.pub).toString("base64url") }; },
    });

    ctx.tool("relay.route.sign", {
      internal: true,
      description: "Sign a name-directory request with the route key. Only a message that begins vyre-names-v1, a newline and this box's own route is signed. Modules only.",
      input: obj({ message: str }, ["message"]),
      run: async (input, meta) => {
        only(meta, ["names"], "signing with the route key");
        await keys.ready();
        const msg = Buffer.from(String(input.message || ""), "base64url");
        if (!msg.subarray(0, `vyre-names-v1\n${route()}\n`.length).equals(Buffer.from(`vyre-names-v1\n${route()}\n`))) throw fail("bad_input", "only a name-directory message for this box's own route is signed");
        return { sig: (await keys.route.sign(msg)).toString("base64url") };
      },
    });

    // The install line's own boot: the code arrives in VYRE_SETUP_CODE (never argv), is taken once and
    // removed from this process's environment so no child inherits it.
    // The installer also writes VYRE_SETUP_CODE_AT (epoch seconds, or milliseconds). A code is used
    // only with a stamp that parses and is no older than the setup hour and no more than five minutes
    // ahead: a missing, garbage or future stamp means no code, so a restart of vyred never re-arms an old one.
    const bootEnv = seam.env || process.env;
    const bootCode = bootEnv.VYRE_SETUP_CODE, bootAt = Number(bootEnv.VYRE_SETUP_CODE_AT);
    if (!seam.env) { delete process.env.VYRE_SETUP_CODE; delete process.env.VYRE_SETUP_CODE_AT; }
    if (bootCode) {
      const at = bootAt > 1e12 ? bootAt : bootAt * 1000, age = Date.now() - at;
      if (!(Number.isFinite(at) && at > 0 && age >= -5 * 60_000 && age <= SETUP_TTL)) { bootSetupFailure = "the code on the install line is older than an hour (or has no valid time), so it was not used; make a new install line in the app"; ctx.log("relay: the setup code on this box has no valid stamp within the last hour and was not used"); }
      else void (async () => {
        // a refusal that cannot change (this box has an owner) ends at once with its reason; anything else (a busy or briefly unreachable relay) is tried again with a growing pause until the code's hour is over
        let wait = Number(ctx.config && ctx.config.relay && ctx.config.relay.setupRetryMs) || 3000;
        for (;;) {
          try { await beginSetup(String(bootCode)); bootSetupFailure = null; bootSetupRetrying = false; return; } catch (err) {
            const e = /** @type {any} */ (err);
            const final = !e || e.code === "denied" || e.code === "unsupported" || stopping || Date.now() - at + wait > SETUP_TTL;
            ctx.log(`relay: setup code not used${final ? "" : " yet, trying again"}: ${e && e.message}`);
            if (final) { bootSetupRetrying = false; bootSetupFailure = `the relay or this box refused the setup code: ${e && e.message}`; return; }
            bootSetupRetrying = true; bootSetupFailure = `the relay is busy or not answering (${e && e.message}); trying again`;
            await nap(wait); wait = Math.min(wait * 2, 60_000);
          }
        }
      })();
    }

    // Taking a device's presence key away (presence.remove) takes the device away too: its open
    // channel closes with 4401 "device removed" and it is refused on reconnect, the same as relay.devices.remove.
    // The person session that opened a pairing window ended (signed out or revoked): the window closes at once, not 30 s later.
    const offSignedOut = ctx.events.on("presence.signed-out", (/** @type {any} */ ev) => {
      const id = ev && ev.payload && ev.payload.id;
      if (pairWindow && id && pairWindow.who.endsWith(`|${id}`)) closeWindow("session ended");
    });
    const offPresence = ctx.events.on("presence.removed", (/** @type {any} */ ev) => {
      const keyId = ev && ev.payload && ev.payload.id;
      if (!keyId) return;
      const row = /** @type {any} */ (db.prepare("SELECT id FROM relay_devices WHERE presence_key = ? AND removed_at IS NULL").get(String(keyId)));
      if (row) forget(row.id, "presence key removed");
    });

    return { async stop() { stopping = true; try { offNameA(); offNameB(); offTunnelUrl(); offDomains(); } catch {} stopTunnel(); try { offPresence(); } catch {} try { offSignedOut(); } catch {} for (const id of [...pendingPairs.keys()]) pendingDrop(id, "box stopping"); clearInterval(windowTimer); if (pairWindow) await closeWindow("stopped"); stopLink(); if (setup) clearTimeout(setup.timer); for (const set of live.values()) for (const ch of set) ch.close(1001, "box stopping"); live.clear(); } };
  },
};
