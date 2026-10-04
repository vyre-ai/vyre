// @ts-check
// relay: a second way to reach the box besides Tailscale (ADR 0026). The box dials out to a
// relay; a device paired by QR code meets it there and runs a Noise IK handshake with the box's
// key. The box admits only devices it paired, names each one `device:<id>`, and hands its
// requests to vyred's router, where it is the owner on their own device, like `tailnet:<owner>`.
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
import { bridge } from "./bridge.js";
import { peersFor } from "./peers.js";
import { pairUrl, parsePairUrl } from "./pairing.js";
import { knownBuild, findRelease, newestRelease } from "./releases.js";
import { agentClaim, ownerDevice } from "../modules/index.js";
import { loadKeys, keyHandle } from "./keys.js";
import { fingerprint8, toBase64url } from "../../lib/identity.js";
import { redeem } from "./redeem.js";
import { deviceIdOf } from "../../lib/caller.js";
import { tailscaleApi, desktopJoin, pairedBox, MINT_ITEM, DEVICE_TAG, JOIN_PATH } from "./tailnet.js";
import { DEFAULT_RELAY } from "../../lib/relay-default.js";

export { loadKeys } from "./keys.js";
export { DEFAULT_RELAY } from "../../lib/relay-default.js";
const PAIR_TTL = 10 * 60_000;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
const DAY = 24 * 60 * 60_000;
/** What an untrusted web device may not call: minting devices, trust, presence keys, secrets out. */
export const WEB_DENY = /^(relay\.pair\.|relay\.devices\.trust$|relay\.enable$|relay\.web\.pin$|network\.tailscale\.login$|relay\.setup\.claim$|presence\.(enroll|code|remove)$|vault\.(reveal|copy|render|resolve|release|export|fill\.|session\.open$))/;
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
  // apart from node_id, so nothing can admit it, and retried until Tailscale confirms.
  `ALTER TABLE relay_devices ADD COLUMN orphan_node TEXT;`,
  // relay.devices.ask-trust: when an untrusted browser last asked to be trusted (once per limit).
  `ALTER TABLE relay_devices ADD COLUMN trust_asked INTEGER;`,
  // Where the app SAYS it made its device key (hardware | software | unknown), from the pairing hello: self-reported, display only (the Devices line shows only "software").
  `ALTER TABLE relay_devices ADD COLUMN key_storage TEXT NOT NULL DEFAULT 'unknown';`,
];
/** A direct report counts as the device's path for this long; the app reports on every switch. */
const DIRECT_FRESH = 10 * 60_000;
const LINK_TTL = 5 * 60_000;
/** A desktop gets a fresh key at most this often, and this many in all, per pairing. */
const JOIN_GAP = 5 * 60_000;
const JOIN_MAX = 5;
/** How long the bind code handed out with a key stays good: the join plus a slow first connect. */
const BIND_TTL = 15 * 60_000;
/** How often the device list asks Tailscale which tagged nodes still exist. */
const NODES_FRESH = 10 * 60_000;

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
 * default on local role (core/relay/keys.js, docs/work/tailnet.md "Needs from others"). Refuse
 * plainly rather than ship the gap on any of these paths.
 *
 * A pure function of an explicit platform, like installCommand/operator in core/names/tailscale.js,
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
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = seam.now || Date.now;
    const platform = seam.platform || process.platform;
    const settings = () => ({ enabled: false, url: DEFAULT_RELAY, web_expiry_days: 30, ...(ctx.config.relay || {}) });
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

    // ---- the tailnet join (ADR 0046) ----

    const ts = tailscaleApi({ credential: () => ctx.vault.fetch(MINT_ITEM) });
    /** Bind codes handed out with a key, by device id: only inside that device's own channel. */
    /** @type {Map<string, { hash: Buffer, exp: number }>} */
    const binding = new Map();
    const answer = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    /**
     * A paired desktop's tailnet key: single use, 5 minutes, tagged tag:vyre-device, minted only
     * for a device whose own pairing asked for it, never on a Mac server before vyre-core. The
     * bind code beside it is what later proves, over the tailnet, that the new node is this device.
     * @param {string} id @param {any} res
     */
    async function tailnetKey(id, res) {
      const refusal = macCoreRefusal(platform, keys.core);
      if (refusal) return answer(res, 403, { error: { code: refusal.code, message: refusal.message } });
      const row = /** @type {any} */ (db.prepare("SELECT kind, join_grant, join_mints, join_last, node_id, node_tagged FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (row && row.node_tagged && row.node_id) return answer(res, 409, { error: { code: "already_joined", message: "this device is already on the tailnet" } });
      if (!row || row.kind !== "app" || !row.join_grant) return answer(res, 403, { error: { code: "denied", message: "this device's pairing did not ask to join the tailnet" } });
      if (row.join_mints >= JOIN_MAX) return answer(res, 403, { error: { code: "denied", message: "too many tailnet keys for one pairing; pair this device again" } });
      if (row.join_last && now() - row.join_last < JOIN_GAP) return answer(res, 429, { error: { code: "rate_limited", message: "a tailnet key was made for this device a moment ago; try again in a few minutes" } });
      // The box's own tailnet address, as the names module saved it (network.address).
      const address = ctx.config.network && typeof ctx.config.network.address === "string" && /^https:\/\/[^\s/]+$/.test(ctx.config.network.address) ? ctx.config.network.address : null;
      if (!address) return answer(res, 409, { error: { code: "no_tailnet", message: "this box is not on a tailnet yet; the relay carries this device" } });
      // The gap holds for every attempt (it paces calls to Tailscale); only a real key counts
      // toward the cap, so a box whose OAuth client is not set up yet costs the desktop nothing.
      db.prepare("UPDATE relay_devices SET join_last = ? WHERE id = ?").run(now(), id);
      let minted;
      try { minted = await ts.mintKey(id); }
      catch (e) {
        const code = /** @type {any} */ (e).code || "mint_failed";
        ctx.log(`relay: no tailnet key for device ${id}: ${/** @type {Error} */ (e).message}`);
        return answer(res, code === "not_set_up" ? 409 : 502, { error: { code, message: /** @type {Error} */ (e).message } });
      }
      db.prepare("UPDATE relay_devices SET join_mints = join_mints + 1 WHERE id = ?").run(id);
      const bindCode = crypto.randomBytes(16).toString("base64url");
      binding.set(id, { hash: sha(bindCode), exp: now() + BIND_TTL });
      ctx.log(`relay: minted a tailnet key for device ${id}`);
      return answer(res, 200, { data: { authKey: minted.key, expiresAt: minted.expiresAt, bindCode, device: id, address, tag: DEVICE_TAG } });
    }
    /** Delete every removed device's leftover tagged node; each success clears its row. */
    let deleting = null;
    const deleteOrphans = () => {
      if (deleting || macCoreRefusal(platform, keys.core)) return deleting;
      const rows = /** @type {any[]} */ (db.prepare("SELECT id, orphan_node FROM relay_devices WHERE orphan_node IS NOT NULL").all());
      if (!rows.length) return null;
      deleting = (async () => {
        for (const r of rows) {
          try {
            await ts.deleteNode(r.orphan_node);
            db.prepare("UPDATE relay_devices SET orphan_node = NULL WHERE id = ? AND orphan_node = ?").run(r.id, r.orphan_node);
            ctx.log(`relay: deleted tailnet node ${r.orphan_node} with device ${r.id}`);
          } catch (e) {
            ctx.log(`relay: could not delete tailnet node ${r.orphan_node}: ${/** @type {Error} */ (e).message}`);
            ctx.events.emit("tailnet.revoke-failed", { id: r.id, node: r.orphan_node, why: String(/** @type {Error} */ (e).message).slice(0, 200) });
          }
        }
      })().finally(() => { deleting = null; });
      return deleting;
    };
    /** Which tagged nodes Tailscale still has, asked at most every NODES_FRESH, off the list's path. */
    let nodesAt = 0;
    const pruneGoneNodes = () => {
      const rows = /** @type {any[]} */ (db.prepare("SELECT id, node_id FROM relay_devices WHERE removed_at IS NULL AND node_tagged = 1 AND node_id IS NOT NULL").all());
      if (!rows.length || now() - nodesAt < NODES_FRESH || macCoreRefusal(platform, keys.core)) return;
      nodesAt = now();
      ts.nodeIds().then(ids => {
        for (const r of rows) if (!ids.has(r.node_id)) {
          // Deleted in the admin console, outside Vyre: the device stays paired, on the relay only.
          db.prepare("UPDATE relay_devices SET node_id = NULL, node_name = NULL, node_tagged = 0 WHERE id = ?").run(r.id);
          ctx.log(`relay: tailnet node ${r.node_id} is gone; device ${r.id} is relay-only now`);
        }
      }).catch(() => {});
    };

    const active = () => /** @type {any[]} */ (db.prepare("SELECT id, name, pub, presence_key, paired_at, last_seen, kind, release, manifest, trusted, trust_asked, node_id, node_name, last_path, path_at, rtt, key_storage FROM relay_devices WHERE removed_at IS NULL AND kind != 'setup' ORDER BY paired_at").all());
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

    /** Who may come in: a paired device, or a device holding the live pairing secret. */
    async function admit(pub, hello) {
      const id = deviceId(pub);
      // The setup page (tailnet plan 3.6b) is its own path: a hello that says "setup", or a device
      // the setup session already admitted, is checked against the setup code's key and nothing else.
      const existing = /** @type {any} */ (db.prepare("SELECT kind FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if ((hello && hello.setup && typeof hello.setup === "object") || (existing && existing.kind === "setup")) return admitSetup(pub, hello, id, existing);
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
        return { v: 1, box: { name: boxName() }, pending: id };
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
        const r = await ctx.call("presence.enroll", { kind: "device", name, public_key: pk.public_key, alg: pk.alg ?? -7 });
        if (r && r.data && (r.data.keyId || r.data.id)) { presenceKey = String(r.data.keyId || r.data.id); presence = { enrolled: true, reason: "" }; }
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
      // box's own address: the same grant, and the same {grant, expires, rpId}, as relay.setup.claim
      // gives the setup QR's phone. Not bound to a peer: at the address the phone is a tailnet node
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
      const keep = { v: 1, ...(hello.kind === "web" ? { kind: "web" } : {}), ...(hello.tailnet ? { tailnet: hello.tailnet } : {}), ...(hello.enroll ? { enroll: hello.enroll } : {}), ...(hello.release ? { release: hello.release } : {}), ...(hello.manifest ? { manifest: hello.manifest } : {}), ...(hello.presenceKey ? { presenceKey: hello.presenceKey } : {}), ...(hello.passkey ? { passkey: hello.passkey } : {}) };
      const p = { pub: Buffer.from(pub), name, hello: keep, gate: String(match.gate), match, channels: new Set(), timer: setTimeout(() => pendingDrop(id, "nobody confirmed this pairing in time"), PENDING_MS) };
      if (p.timer.unref) p.timer.unref();
      pendingPairs.set(id, p);
      ctx.events.emit("pairing.pending", { device: id, name, fingerprint: keyFingerprint(pub), gate: p.gate, via: String(match.via || "ticket") });
      return { v: 1, box: { name: boxName() }, pending: id };
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
      return pk && typeof pk.public_key === "string" ? { key: pk.public_key, alg: pk.alg ?? -7, storage: ["hardware", "software"].includes(pk.storage) ? pk.storage : "unknown" } : {};
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
      const record = ticketSeal(s.secret, JSON.stringify({ v: 1, name: boxName(), handle: boxHandle(), address: addressOrigin(), identity: identityFingerprint(), relay: settings().url, route: route(), box: k().box.pub.toString("base64url"), exp: s.exp }));
      const mac = ticketMac(s.secret, record);
      const status = link ? await link.registerSetup({ loc: s.loc, record, mac: mac.toString("base64url"), exp: s.exp }) : null;
      s.registered = status === 200;
      if (status === 409 && setup === s) {
        s.state = "contested";
        dropSetupDevices();
        ctx.events.emit("setup.contested", {});
      }
      return setupStatus();
    }

    const setupStatus = () => {
      const s = setup;
      if (!s || !s.live) return { state: "none" };
      return { state: s.state, registered: s.registered, ticket: s.ticket === "minted", expiresAt: s.exp, ownerExists: personExists(),
        words: s.words(k().box.pub).join(" ") };
    };
    const setupHandler = setupGate({ session: () => setup, extraTools: () => (typeof ctx.declaredSetupTools === "function" ? ctx.declaredSetupTools() : []), ownerExists: personExists, handlerFor: policy => ctx.handler(policy),
      mintTicket: async () => { const refusal = macCoreRefusal(platform, keys.core); if (refusal) throw refusal; return mintTicket(); },
      recoverCode: async input => { const r = /** @type {any} */ (await ctx.call("names.recover.code", input)); return r && r.data !== undefined ? r.data : r; } });

    /** The caller label the relay listener hands a paired device, by its kind; null for a kind that may not connect. @param {string} kind @param {string} id */
    const callerLabel = (kind, id) => kind === "app" ? `device:${id}` : kind === "web" ? `web:${id}` : kind === "setup" ? `setup:${id}` : null;
    let handle = null, webHandle = null, upgrade = null;
    function onchannel(channel, { reply }) {
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
      // The label is the trust claim (BR-2, lead ruling 4 Oct 2026): `device:<id>` only for a live, confirmed device of kind app. A browser is `web:<id>` and a setup page `setup:<id>`,
      // labels the registry never admits as an owner's device, so they reach just the tools that name their class. Any other kind gets no label and no channel.
      const label = callerLabel(row.kind, id);
      if (!label) { channel.close(4401, "this device cannot connect"); return; }
      if (!handle) handle = ctx.handler({});
      if (!webHandle) webHandle = ctx.handler({ tool: name => !WEB_DENY.test(name) });
      const limited = row.kind === "web" && !row.trusted;
      const peer = { node: row.name, stableId: id, login: null, tags: [], caps: {}, kind: "device", ...(row.kind === "web" ? { web: true } : {}) };
      const routed = row.kind === "setup" ? setupHandler : limited ? webHandle : handle;
      // The tailnet key is answered here, before vyred's router ever sees the request, so it is
      // reachable only from inside this device's own Noise channel and never as a tool.
      const handler = (req, res, caller, p) => (req.method === "POST" && req.url === JOIN_PATH ? tailnetKey(id, res) : routed(req, res, caller, p));
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

    // This machine as a desktop of another box (ADR 0046): one join attempt at a time, once after
    // pairing and once at each start until it has joined. Never on a Mac before vyre-core.
    let joining = null;
    const joinTailnet = () => {
      if (joining || macCoreRefusal(platform, keys.core) || !pairedBox(ctx.paths.root)) return;
      joining = desktopJoin({ root: ctx.paths.root, coreKeys: keys.client, hostname: String(ctx.config.name || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63) || undefined, log: m => ctx.log(m) })
        .then(r => { if (r.state !== "unpaired") ctx.events.emit("tailnet.tried", { state: r.state, ...(r.why ? { why: r.why } : {}) }); return r; })
        .catch(e => ctx.log(`relay: tailnet join: ${e.message}`))
        .finally(() => { joining = null; });
    };
    joinTailnet();

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
      // Revoke goes both ways (ADR 0046): the binding goes at once, so nothing can admit the node
      // again (a re-pairing included), and the node itself is deleted from the tailnet, retried
      // until Tailscale confirms. A failed delete is logged and shown, never a half-trusted device.
      const orphan = row.node_tagged && row.node_id ? row.node_id : null;
      // Only what the 4401 answer needs stays (the key and the time): the name the person deleted, the presence key id, the build and the path are blanked.
      db.prepare("UPDATE relay_devices SET removed_at = ?, name = '', presence_key = NULL, release = NULL, manifest = NULL, trusted = 0, last_path = NULL, rtt = NULL, join_grant = 0, node_id = NULL, node_name = NULL, node_tagged = 0, orphan_node = COALESCE(?, orphan_node) WHERE id = ?").run(now(), orphan, id);
      binding.delete(id);
      if (orphan) deleteOrphans();
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
        const mine = pairedBox(ctx.paths.root);
        if (s.enabled || await keys.exists()) await keys.ready();
        return { enabled: Boolean(s.enabled), url: s.url, connected: Boolean(link && link.connected), route: s.enabled || keys.loaded ? route() : null,
          devices: active().length, open: link ? link.open : 0, pairing: pairing && pairing.exp > now() ? { expiresAt: pairing.exp } : null,
          // This machine's own tailnet join as another box's desktop (ADR 0046), when it is one.
          ...(mine ? { tailnet: mine.tailnet || { state: "pending" } } : {}) };
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
        if (url !== settings().url) stopLink();
        await keys.ready();
        save({ enabled: true, url });
        startLink();
        return { enabled: true, url };
      },
    });

    ctx.tool("relay.enable", {
      description: "Turn the relay on: the box connects out to the relay so paired devices can reach it without Tailscale.",
      input: obj({ url: str }),
      presence: { summary: async () => "Let paired devices reach this box through the relay" },
      run: async (input, meta = {}) => {
        owner(meta.caller, meta, "turning the relay on");
        const url = input.url ? String(input.url) : settings().url;
        if (!/^wss?:\/\/[^\s/]+/.test(url)) throw fail("bad_input", "url must be a ws:// or wss:// address");
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
      return { url: pairUrl({ relay: settings().url, route: route(), box: k().box.pub, secret, name: boxName() }), expiresAt: pairing.exp, connected };
    };

    ctx.tool("relay.pair.start", {
      description: "Make a QR code that pairs one more device with this box through the relay. The code works once, for 10 minutes; making a new one voids the last.",
      input: obj(),
      presence: { summary: async () => "Pair a new device with this box" },
      // The surfaces, the owner's own devices, and a module (onboard runs this step); owner() below refuses a model, an agent, a hook, a guest and anonymous.
      callers: ["cli", "local", "deck", "capsule", "tailnet", "module"],
      run: async (_, meta = {}) => { owner(meta.caller, meta, "pairing a device"); return mint(false); },
    });

    ctx.tool("relay.pair.first", {
      description: "During onboarding only, before this box has any person on a device: make the QR code for the first device. Refused once a device is paired or a tailnet owner exists.",
      input: obj(),
      callers: ["onboard"],
      // On a Mac the person at it proves presence with Touch ID; a Linux box has nothing a
      // process cannot also do, which ADR 0026 section 6 names as the residual risk.
      presence: { when: () => platform === "darwin", summary: async () => "Pair your first device with this box" },
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
      const record = ticketSeal(rawTicket, JSON.stringify({ v: 1, name: boxName(), handle: boxHandle(), address: addressOrigin(), identity: identityFingerprint(), relay: settings().url, route: route(), box: k().box.pub.toString("base64url"), exp, ...(opt.offer ? { offer: opt.offer } : {}) }));
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
      description: "This Vyre becomes a device of another box, redeeming a one-time pairing code minted there (relay.pair.start or onboard.join{action:\"relay\"}). One redemption: the channel closes once paired, then this tool returns what the other box said (its name, this device's id, whether presence enrolled). becomeDevice, when true, flips this machine to \"device\" once paired (onboard.machine): the shape onboard.join{action:\"verify\",becomeDevice} uses on the Tailscale path, so the onboarding card calls the same flag either way. Does not keep a connection open; that is not built yet. A pasted URL that is not a real Vyre pairing code is refused before any prompt. Not available on a Mac yet: see vyre-core (ADR 0040).",
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
        try { paired = await redeem(url, { root: ctx.paths.root, name, tailnet: true, coreKeys: keys.client }); }
        catch (e) { throw fail("bad_input", /** @type {Error} */ (e).message); }
        if (becomeDevice) await ctx.call("onboard.machine", { machine: "device" }).catch(() => {});
        // The tailnet upgrade (ADR 0046) runs on its own: pairing already worked over the relay.
        joinTailnet();
        return paired;
      },
    });

    ctx.tool("relay.devices.list", {
      callers: ["web"],
      description: "Devices paired through the relay: id, name, when paired and last seen, whether presence is enrolled, and whether it is connected now.",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta.caller, meta, "the device list");
        for (const d of active()) if (expired(d)) forget(d.id, "expired");
        pruneGoneNodes();
        deleteOrphans();
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
        if (callerDevice !== null && meta.peer && meta.peer.via === "tailnet") {
          // A desktop bound through ADR 0046's tagged join, calling over its own tailnet node.
          const id = callerDevice;
          moved(id, input.path === "direct" ? "direct" : "relay", rtt);
          return { path: input.path, device: id };
        }
        if (callerDevice !== null) {
          const id = callerDevice;
          if (input.path !== "relay") throw fail("bad_input", "through the relay, a device reports the relay path");
          moved(id, "relay", rtt);
          const code = crypto.randomBytes(16).toString("base64url");
          linking.set(id, { hash: sha(code), exp: now() + LINK_TTL });
          return { path: "relay", link: code };
        }
        if (!c.startsWith("tailnet:")) throw fail("denied", "only a paired device, over the relay or its own tailnet node, reports a path");
        // Keyed on the node's stable id only: a node's name can change. A fake tailnet may give none.
        const node = meta.peer && meta.peer.stableId;
        if (!node) throw fail("no_node", "this device's tailnet node has no stable id");
        if (input.id && input.code) {
          const l = linking.get(String(input.id));
          if (!l || l.exp < now() || !crypto.timingSafeEqual(sha(input.code), l.hash)) throw fail("denied", "that link code has expired or was already used");
          linking.delete(String(input.id));
          db.prepare("UPDATE relay_devices SET node_id = ?, node_name = ? WHERE id = ? AND removed_at IS NULL").run(String(node), String(meta.peer.node || ""), String(input.id));
        }
        const row = /** @type {any} */ (db.prepare("SELECT id FROM relay_devices WHERE node_id = ? AND removed_at IS NULL").get(String(node)));
        if (!row) throw fail("bad_input", "this tailnet node is not linked to a paired device yet: report over the relay first and pass its code");
        moved(row.id, input.path === "direct" ? "direct" : "relay", rtt);
        return { path: input.path, device: row.id };
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

    // ADR 0046, the names listener's half: whois says which tailnet node is calling, and only
    // these two internal tools turn that into a paired device. A tag never names anyone by itself.
    ctx.tool("relay.devices.tailnet", {
      internal: true,
      description: "The paired desktop bound to a tagged tailnet node (ADR 0046), or null.",
      input: obj({ stableId: str }, ["stableId"]),
      run: async input => {
        const row = /** @type {any} */ (db.prepare("SELECT id FROM relay_devices WHERE node_id = ? AND node_tagged = 1 AND kind = 'app' AND removed_at IS NULL").get(String(input.stableId)));
        return { device: row ? row.id : null };
      },
    });

    ctx.tool("relay.devices.bind", {
      internal: true,
      description: "Bind a new tagged tailnet node to the paired desktop whose bind code it presents (ADR 0046). The names listener calls it with whois's own stable id; the code was handed out only inside that device's Noise channel, with its key.",
      input: obj({ stableId: str, node: str, device: str, code: str }, ["stableId", "device", "code"]),
      run: async (input, meta = {}) => {
        if (meta.caller !== "module:names") throw fail("denied", "only the tailnet listener binds a node");
        const id = String(input.device);
        const b = binding.get(id);
        if (!b || b.exp < now() || !crypto.timingSafeEqual(sha(input.code), b.hash)) throw fail("denied", "that bind code has expired or was already used");
        binding.delete(id);
        const node = String(input.stableId);
        if (!/^[A-Za-z0-9]{1,64}$/.test(node)) throw fail("bad_input", "not a tailnet node id");
        // One node, one device: a node id that somehow sat on another row leaves it.
        db.prepare("UPDATE relay_devices SET node_id = NULL, node_name = NULL, node_tagged = 0 WHERE node_id = ? AND id != ?").run(node, id);
        const r = db.prepare("UPDATE relay_devices SET node_id = ?, node_name = ?, node_tagged = 1, join_grant = 0 WHERE id = ? AND kind = 'app' AND removed_at IS NULL").run(node, promptSafe(input.node, "", 64), id);
        if (!r.changes) throw fail("not_found", `no paired desktop ${id}`);
        ctx.events.emit("device.joined", { id, node });
        return { device: id, node };
      },
    });

    ctx.tool("relay.tailnet.status", {
      description: "Whether this box can hand paired desktops a tailnet key (ADR 0046): the vault item it mints with, the tag, and why not when it cannot. Never the credential itself.",
      input: obj(),
      run: async (_, meta = {}) => {
        owner(meta.caller, meta, "the tailnet join");
        const refusal = macCoreRefusal(platform, keys.core);
        const bound = /** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM relay_devices WHERE removed_at IS NULL AND node_tagged = 1").get()).n;
        return { available: !refusal, why: refusal ? refusal.message : null, item: MINT_ITEM, tag: DEVICE_TAG, joined: bound };
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

    ctx.tool("relay.device.presence", {
      internal: true,
      description: "The presence key id enrolled for a paired relay device, or null.",
      input: obj({ id: str }, ["id"]),
      run: async input => {
        const row = /** @type {any} */ (db.prepare("SELECT presence_key FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(String(input.id)));
        return { key: (row && row.presence_key) || null };
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
      callers: ["cli", "local", "deck", "capsule", "tailnet", "device", "module"],
      description: "Where the setup session is: none, waiting for the page, paired, or contested (another server used the code first), whether the relay holds the offer, whether the one pairing ticket is made, when the hour ends, and the four check words the page shows too.",
      input: obj(),
      run: async (_, meta = {}) => { owner(meta.caller, meta, "the setup status"); return setupStatus(); },
    });

    // The claim token (B4). The page mints a challenge over the setup channel, signs it with its key
    // and carries the result to the address in the URL fragment; there, claim checks it and gives the
    // browser one 5-minute grant for the first owner passkey. The setup ticket's phone claims the same
    // way from a QR of the same link.
    ctx.tool("relay.setup.claim-token", {
      description: "Setup page only: a one-time challenge (two minutes) for a claim at the given address. The page signs it with its own key and puts the result in the link's fragment.",
      input: obj({ host: str }, ["host"]),
      run: async (input, meta = {}) => {
        if (!setup || !setup.live || !setup.device || String(meta.caller || "") !== `setup:${setup.device}`) throw fail("denied", "only this box's setup page can make a claim token");
        return { ...setup.mintClaim(String(input.host || "")), route: route() };
      },
    });

    ctx.tool("relay.setup.claim", {
      description: "At the box's own address: check a claim token from the setup page and answer a one-time, five-minute grant for enrolling the first owner passkey from this browser. The challenge is burned by the first try.",
      input: obj({ token: str, spki: str }, ["token", "spki"]),
      run: async (input, meta = {}) => {
        const c = String(meta.caller || "");
        if (!(ownerDevice(c) && !agentClaim(c)) || (meta && meta.agent)) throw fail("denied", "a claim is made from the owner's own browser at the box's address");
        if (!setup) throw fail("denied", "that claim is not valid");
        const host = setup.takeClaim({ token: String(input.token || ""), spki: String(input.spki || ""), route: route(), origin: String((meta.peer && meta.peer.origin) || "") });
        const r = /** @type {any} */ (await ctx.call("presence.grant.mint", { peer: meta.peer || null, host }));
        if (!r || r.error || !r.data) throw fail("failed", "could not make the grant");
        return { grant: r.data.grant, expires: r.data.expires, rpId: host };
      },
    });

    // The route key's two calls for the names directory (core/names cannot import this module).
    // Modules only. sign refuses any message that does not open with the names tag and this box's
    // own route, so the key is never a general signing oracle (the relay's own box-auth message
    // does not begin that way).
    ctx.tool("relay.route.id", {
      internal: true,
      description: "This box's route id and route public key (base64url), for signing into the name directory, and the box's own public key (`box`), which the Wink module hashes into the words a pairing shows. Modules only.",
      input: obj(),
      run: async (_, meta) => { only(meta, ["names", "wink"], "the route id"); await keys.ready(); return { route: route(), pub: Buffer.from(k().route.pub).toString("base64url"), box: Buffer.from(k().box.pub).toString("base64url") }; },
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
      if (!(Number.isFinite(at) && at > 0 && age >= -5 * 60_000 && age <= SETUP_TTL)) ctx.log("relay: the setup code on this box has no valid stamp within the last hour and was not used");
      else beginSetup(String(bootCode)).catch(e => ctx.log(`relay: setup code not used: ${/** @type {Error} */ (e).message}`));
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

    return { async stop() { try { offPresence(); } catch {} try { offSignedOut(); } catch {} for (const id of [...pendingPairs.keys()]) pendingDrop(id, "box stopping"); clearInterval(windowTimer); if (pairWindow) await closeWindow("stopped"); stopLink(); if (setup) clearTimeout(setup.timer); for (const set of live.values()) for (const ch of set) ch.close(1001, "box stopping"); live.clear(); } };
  },
};
