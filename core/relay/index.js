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
import * as config from "../config/index.js";
import { routeId, base32, TICKET_BYTES, TICKET_TTL, ticketDerive, ticketMac, ticketSeal, SETUP_TTL } from "./wire.js";
import { SetupSession, setupGate } from "./setup.js";
import { relayLink } from "./link.js";
import { bridge } from "./bridge.js";
import { pairUrl, parsePairUrl } from "./pairing.js";
import { knownBuild, findRelease, newestRelease } from "./releases.js";
import { agentClaim } from "../modules/index.js";
import { loadKeys } from "./keys.js";
import { fingerprint8, toBase64url } from "../../lib/identity.js";
import { redeem } from "./redeem.js";
import { tailscaleApi, desktopJoin, pairedBox, MINT_ITEM, DEVICE_TAG, JOIN_PATH } from "./tailnet.js";
import { DEFAULT_RELAY } from "../../lib/relay-default.js";

export { loadKeys } from "./keys.js";
export { DEFAULT_RELAY } from "../../lib/relay-default.js";
const PAIR_TTL = 10 * 60_000;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
const DAY = 24 * 60 * 60_000;
/** What an untrusted web device may not call: minting devices, trust, presence keys, secrets out. */
export const WEB_DENY = /^(relay\.pair\.|relay\.devices\.trust$|relay\.enable$|relay\.web\.pin$|presence\.(enroll|code|remove)$|vault\.(reveal|copy|render|resolve|release|export|fill\.|session\.open$))/;
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
 * (ADR 0040) exists to hold it instead: `relay.join` (this device's own identity key,
 * relay-device/key.json, core/relay/redeem.js) and `relay.pair.ticket` (a pairing whose secret and
 * MAC key derive from a ticket held only in this box's process, same as relay.pair.start's own
 * secret in relay/keys.json). All of it sits at the person's own login uid today, readable and
 * writable by any process at that uid, the same gap that already keeps relay hosting off by
 * default on local role (core/relay/keys.js, docs/work/tailnet.md "Needs from others"). Refuse
 * plainly rather than ship the gap on any of these paths.
 *
 * A pure function of an explicit platform, like installCommand/operator in core/names/tailscale.js,
 * so a test can assert the darwin case without depending on the OS it happens to run on.
 * @param {string} platform
 */
export function macCoreRefusal(platform) {
  return platform === "darwin"
    ? fail("not_available_here", "not available on a Mac yet: this needs vyre-core to hold a key that today would sit unprotected at your login; use a Linux box instead, or wait for vyre-core")
    : null;
}

/**
 * @type {{ start(ctx: any, seam?: { WebSocket?: any, now?: () => number, platform?: string }): Promise<{ stop(): Promise<void> }> }}
 */
export default {
  async start(ctx, seam = {}) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = seam.now || Date.now;
    const platform = seam.platform || process.platform;
    const settings = () => ({ enabled: false, url: DEFAULT_RELAY, web_expiry_days: 30, ...(ctx.config.relay || {}) });
    const save = patch => config.save({ relay: patch }, ctx.paths.root, ctx.config);
    /** @type {ReturnType<typeof loadKeys> | null} */
    let keys = null;
    const k = () => (keys = keys || loadKeys(ctx.paths.root));
    const route = () => routeId(k().route.pub);
    // The box's name as the names module knows it (config.name), never the machine's hostname: it rides in QR codes and
    // shows in screenshots.
    const boxName = () => String(ctx.config.name || (ctx.config.network && ctx.config.network.name) || "Vyre box").slice(0, 64);
    // The claimed <handle>.vyre.run subdomain (core/names/service.js's own `ctx.config.name`,
    // set only once a name is actually claimed), not boxName()'s fallback chain, since a display
    // name is not necessarily a real, resolvable handle. Null when nothing is claimed yet: the
    // lead's 28 Sep ask (so a phone can offer <handle>.vyre.run after pairing, without a guess).
    const boxHandle = () => {
      const h = ctx.config.name;
      return typeof h === "string" && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/i.test(h) ? h.slice(0, 32) : null;
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
    /** Does a presented secret match a live pairing (the classic single one, or a ticket's), and
     * burn it either way? Null when nothing matches. */
    const takeLiveSecret = provided => {
      const h = sha(provided);
      if (pairing && pairing.exp > now() && crypto.timingSafeEqual(h, pairing.hash)) { const m = { first: pairing.first, ticket: false }; pairing = null; return m; }
      const hex = h.toString("hex");
      const t = pendingTickets.get(hex);
      if (t && t.exp > now()) { pendingTickets.delete(hex); return { first: false, ticket: true }; }
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
      const refusal = macCoreRefusal(platform);
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
      if (deleting || macCoreRefusal(platform)) return deleting;
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
      if (!rows.length || now() - nodesAt < NODES_FRESH || macCoreRefusal(platform)) return;
      nodesAt = now();
      ts.nodeIds().then(ids => {
        for (const r of rows) if (!ids.has(r.node_id)) {
          // Deleted in the admin console, outside Vyre: the device stays paired, on the relay only.
          db.prepare("UPDATE relay_devices SET node_id = NULL, node_name = NULL, node_tagged = 0 WHERE id = ?").run(r.id);
          ctx.log(`relay: tailnet node ${r.node_id} is gone; device ${r.id} is relay-only now`);
        }
      }).catch(() => {});
    };

    const active = () => /** @type {any[]} */ (db.prepare("SELECT id, name, pub, presence_key, paired_at, last_seen, kind, release, manifest, trusted, node_id, node_name, last_path, path_at, rtt FROM relay_devices WHERE removed_at IS NULL AND kind != 'setup' ORDER BY paired_at").all());
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
    };

    // ---- the link ----

    /** @type {ReturnType<typeof relayLink> | null} */
    let link = null;
    const startLink = () => {
      if (link) return;
      link = relayLink({
        url: settings().url, route: route(), routeKey: k().route, boxKey: k().box, admit, onchannel,
        WebSocket: seam.WebSocket, log: m => ctx.log(m),
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
        const name = promptSafe(typeof hello.name === "string" ? hello.name.trim() : "", "a device", 64);
        const kind = hello.kind === "web" ? "web" : "app";
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
        db.prepare(`INSERT INTO relay_devices (id, name, pub, presence_key, paired_at, last_seen, removed_at, kind, release, manifest, trusted, join_grant, join_mints, join_last) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, 0, NULL)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, pub = excluded.pub, presence_key = excluded.presence_key, paired_at = excluded.paired_at, last_seen = excluded.last_seen, removed_at = NULL,
            kind = excluded.kind, release = excluded.release, manifest = excluded.manifest, trusted = 0, join_grant = excluded.join_grant, join_mints = 0, join_last = NULL,
            node_id = NULL, node_name = NULL, node_tagged = 0`)
          .run(id, name, pub.toString("base64url"), presenceKey, now(), now(), kind, release, manifest, grant);
        // The pairing notice: every surface shows it with a one-tap removal (ADR 0026 section 6).
        // Carries the new device's own key fingerprint (reviewer, 28 Sep LOW) so the notice reads
        // the same short form ("a1b2 c3d4") as every other Touch ID / confirm screen that shows one.
        ctx.events.emit("device.paired", { id, name, kind, fingerprint: keyFingerprint(pub), ...(kind === "web" ? { release, build: knownBuild(release, manifest) ? "known" : "unknown" } : {}) });
        // The scan-to-pair screen's own event (ADR 0045, the lead 28 Sep): only for a ticket
        // pairing, so a Deck showing "Add your phone" reacts to its own flow and not to someone
        // pairing a different device with the classic QR at the same time.
        if (match.ticket) ctx.events.emit("relay.paired", { device: id, name, fingerprint: keyFingerprint(pub) });
        return { v: 1, box: { name: boxName() }, device: id, paired: true, presence };
      }
      const row = /** @type {any} */ (db.prepare("SELECT id, pub, kind, paired_at, last_seen FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (!row || !crypto.timingSafeEqual(Buffer.from(row.pub, "base64url"), pub)) throw new Error("not a paired device");
      if (expired(row)) { forget(id, "expired"); throw new Error("this browser went unused too long and was removed; pair it again from another device"); }
      const release = hello && typeof hello.release === "string" && BUILD.test(hello.release) ? hello.release : null;
      const manifest = hello && typeof hello.manifest === "string" && /^[a-f0-9]{64}$/.test(hello.manifest) ? hello.manifest : null;
      if (row.kind === "web") db.prepare("UPDATE relay_devices SET last_seen = ?, release = ?, manifest = ? WHERE id = ?").run(now(), release, manifest, id);
      else db.prepare("UPDATE relay_devices SET last_seen = ? WHERE id = ?").run(now(), id);
      return { v: 1, box: { name: boxName() }, device: id };
    }

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
     * Start a setup session from the code on the install line (VYRE_CODE): discard any earlier
     * unclaimed session and its device, register the sealed offer at the code's locator (first
     * writer wins there; a 409 means another server used this code first), and start the hour.
     * @param {string} code
     */
    async function beginSetup(code) {
      const refusal = macCoreRefusal(platform);
      if (refusal) throw refusal;
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
      const record = ticketSeal(s.secret, JSON.stringify({ v: 1, name: boxName(), handle: boxHandle(), identity: identityFingerprint(), relay: settings().url, route: route(), box: k().box.pub.toString("base64url"), exp: s.exp }));
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
    const setupHandler = setupGate({ session: () => setup, ownerExists: personExists, handlerFor: policy => ctx.handler(policy),
      mintTicket: async () => { const refusal = macCoreRefusal(platform); if (refusal) throw refusal; return mintTicket(); },
      recoverCode: async input => { const r = /** @type {any} */ (await ctx.call("names.recover.code", input)); return r && r.data !== undefined ? r.data : r; } });

    let handle = null, webHandle = null, upgrade = null;
    function onchannel(channel, { reply }) {
      const id = String(reply.device);
      const row = /** @type {any} */ (db.prepare("SELECT name, kind, trusted FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (!row) { channel.close(4401, "device removed"); return; }
      if (!handle) handle = ctx.handler({});
      if (!webHandle) webHandle = ctx.handler({ tool: name => !WEB_DENY.test(name) });
      const limited = row.kind === "web" && !row.trusted;
      const peer = { node: row.name, stableId: id, login: null, tags: [], caps: {}, kind: "device", ...(row.kind === "web" ? { web: true } : {}) };
      const routed = row.kind === "setup" ? setupHandler : limited ? webHandle : handle;
      // The tailnet key is answered here, before vyred's router ever sees the request, so it is
      // reachable only from inside this device's own Noise channel and never as a tool.
      const handler = (req, res, caller, p) => (req.method === "POST" && req.url === JOIN_PATH ? tailnetKey(id, res) : routed(req, res, caller, p));
      bridge(channel, { handler, caller: `device:${id}`, peer, upgrade: () => (upgrade = upgrade || ctx.upgrader({})), log: m => ctx.log(m) });
      const set = live.get(id) || new Set();
      set.add(channel);
      live.set(id, set);
      const closed = channel.onclose;
      channel.onclose = reason => { closed(reason); set.delete(channel); };
    }

    if (settings().enabled) startLink();

    // This machine as a desktop of another box (ADR 0046): one join attempt at a time, once after
    // pairing and once at each start until it has joined. Never on a Mac before vyre-core.
    let joining = null;
    const joinTailnet = () => {
      if (joining || macCoreRefusal(platform) || !pairedBox(ctx.paths.root)) return;
      joining = desktopJoin({ root: ctx.paths.root, hostname: String(ctx.config.name || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63) || undefined, log: m => ctx.log(m) })
        .then(r => { if (r.state !== "unpaired") ctx.events.emit("tailnet.tried", { state: r.state, ...(r.why ? { why: r.why } : {}) }); return r; })
        .catch(e => ctx.log(`relay: tailnet join: ${e.message}`))
        .finally(() => { joining = null; });
    };
    joinTailnet();

    // ---- tools ----

    /** Where a device is now: connected through the relay, or reporting from its tailnet node lately. */
    const pathOf = d => ((live.get(d.id)?.size || 0) > 0 ? "relay" : d.last_path === "direct" && now() - (d.path_at || 0) < DIRECT_FRESH ? "direct" : null);
    const view = (d, rtt = null) => ({ id: d.id, name: d.name, kind: d.kind, pairedAt: d.paired_at, lastSeen: d.last_seen, presence: Boolean(d.presence_key),
      online: pathOf(d) !== null, path: pathOf(d), rtt: pathOf(d) === "relay" ? rtt : pathOf(d) === "direct" ? d.rtt : null,
      ...(d.node_id ? { node: d.node_name || d.node_id } : {}),
      ...(d.kind === "web" ? { trusted: Boolean(d.trusted), release: d.release, build: knownBuild(d.release, d.manifest) ? "known" : "unknown",
        expiresAt: (d.last_seen || d.paired_at) + Number(settings().web_expiry_days) * DAY } : {}) });

    /** Remove a device: close its channels, drop its presence key, tell every surface. */
    function forget(id, why) {
      const row = /** @type {any} */ (db.prepare("SELECT presence_key, node_id, node_tagged FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (!row) return false;
      // Revoke goes both ways (ADR 0046): the binding goes at once, so nothing can admit the node
      // again (a re-pairing included), and the node itself is deleted from the tailnet, retried
      // until Tailscale confirms. A failed delete is logged and shown, never a half-trusted device.
      const orphan = row.node_tagged && row.node_id ? row.node_id : null;
      db.prepare("UPDATE relay_devices SET removed_at = ?, join_grant = 0, node_id = NULL, node_name = NULL, node_tagged = 0, orphan_node = COALESCE(?, orphan_node) WHERE id = ?").run(now(), orphan, id);
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
        return { enabled: Boolean(s.enabled), url: s.url, connected: Boolean(link && link.connected), route: s.enabled || keys ? route() : null,
          devices: active().length, open: link ? link.open : 0, pairing: pairing && pairing.exp > now() ? { expiresAt: pairing.exp } : null,
          // This machine's own tailnet join as another box's desktop (ADR 0046), when it is one.
          ...(mine ? { tailnet: mine.tailnet || { state: "pending" } } : {}) };
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
      if (!settings().enabled) save({ enabled: true });
      startLink();
      const connected = link ? await link.ready() : false;
      return { url: pairUrl({ relay: settings().url, route: route(), box: k().box.pub, secret, name: boxName() }), expiresAt: pairing.exp, connected };
    };

    ctx.tool("relay.pair.start", {
      description: "Make a QR code that pairs one more device with this box through the relay. The code works once, for 10 minutes; making a new one voids the last.",
      input: obj(),
      presence: { summary: async () => "Pair a new device with this box" },
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
    const mintTicket = async () => {
      const rawTicket = crypto.randomBytes(TICKET_BYTES);
      const exp = now() + TICKET_TTL;
      const secret = ticketDerive("sec", rawTicket).toString("base64url");
      pendingTickets.set(sha(secret).toString("hex"), { exp });
      if (!settings().enabled) save({ enabled: true });
      startLink();
      const connected = link ? await link.ready() : false;
      // Sealed under the ticket's own "enc" key: the relay holds ciphertext only (wire.js).
      const record = ticketSeal(rawTicket, JSON.stringify({ v: 1, name: boxName(), handle: boxHandle(), identity: identityFingerprint(), relay: settings().url, route: route(), box: k().box.pub.toString("base64url"), exp }));
      const mac = ticketMac(rawTicket, record);
      if (link) link.registerTicket({ loc: ticketDerive("loc", rawTicket).toString("base64url"), record, mac: mac.toString("base64url"), exp });
      return { ticket: rawTicket.toString("base64url"), expiresAt: exp, connected };
    };

    ctx.tool("relay.pair.ticket", {
      description: "Mint a one-time pairing ticket for the Vyre code (Wink): a phone that scans it resolves the box's identity from the relay, then pairs exactly as relay.pair.start's QR does. Works once, for 5 minutes; call again for a fresh one (an old, unused ticket is simply left to expire, unlike relay.pair.start's single live QR). Not available on a Mac yet: see vyre-core (ADR 0040).",
      input: obj(),
      presence: { when: () => !macCoreRefusal(platform), summary: async () => `Pair a new device with this box, by scanning its Vyre code${settings().enabled ? "" : " (this also turns the relay on)"}` },
      run: async (_, meta = {}) => {
        const refusal = macCoreRefusal(platform);
        if (refusal) throw refusal;
        owner(meta.caller, meta, "pairing a device");
        return mintTicket();
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
        when: () => !macCoreRefusal(platform),
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
        const refusal = macCoreRefusal(platform);
        if (refusal) throw refusal;
        owner(meta.caller, meta, "joining another box");
        if (!parsePairUrl(url)) throw fail("bad_input", "that does not look like a real Vyre pairing code");
        let paired;
        try { paired = await redeem(url, { root: ctx.paths.root, name, tailnet: true }); }
        catch (e) { throw fail("bad_input", /** @type {Error} */ (e).message); }
        if (becomeDevice) await ctx.call("onboard.machine", { machine: "device" }).catch(() => {});
        // The tailnet upgrade (ADR 0046) runs on its own: pairing already worked over the relay.
        joinTailnet();
        return paired;
      },
    });

    ctx.tool("relay.devices.list", {
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
        return { devices: rows.map((d, i) => view(d, rtts[i])) };
      },
    });

    ctx.tool("relay.devices.rename", {
      description: "Rename a paired device.",
      input: obj({ id: str, name: str }, ["id", "name"]),
      run: async (input, meta = {}) => {
        owner(meta.caller, meta, "renaming a device");
        const name = String(input.name).trim();
        if (!NAME.test(name)) throw fail("bad_input", "a name is 1 to 64 printable characters");
        const r = db.prepare("UPDATE relay_devices SET name = ? WHERE id = ? AND removed_at IS NULL").run(name, String(input.id));
        if (!r.changes) throw fail("not_found", `no paired device ${input.id}`);
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

    // The hosted app's loader asks which build to load (ADR 0026 section 10, ADR 0027 section 4):
    // the owner's pin, or the newest release this box ships knowing. Open to any paired device,
    // web ones included, since the loader must ask before it can load anything else.
    ctx.tool("relay.web.release", {
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
        if (c.startsWith("device:") && meta.peer && meta.peer.via === "tailnet") {
          // A desktop bound through ADR 0046's tagged join, calling over its own tailnet node.
          const id = c.slice("device:".length);
          moved(id, input.path === "direct" ? "direct" : "relay", rtt);
          return { path: input.path, device: id };
        }
        if (c.startsWith("device:")) {
          const id = c.slice("device:".length);
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
        const refusal = macCoreRefusal(platform);
        const bound = /** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM relay_devices WHERE removed_at IS NULL AND node_tagged = 1").get()).n;
        return { available: !refusal, why: refusal ? refusal.message : null, item: MINT_ITEM, tag: DEVICE_TAG, joined: bound };
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
        db.prepare("UPDATE relay_devices SET trusted = ? WHERE id = ?").run(input.trusted ? 1 : 0, id);
        // Open channels keep the handler they started with: close them so the next one gets the new one.
        for (const ch of live.get(id) || []) ch.close(1000, "trust changed");
        live.delete(id);
        return { id, trusted: Boolean(input.trusted) };
      },
    });

    // The setup session's tools (tailnet plan 3.6b). begin and end are modules-only: the install's
    // own boot (VYRE_CODE, below) and the claim (launch) call them, never a person, a model or a
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
      description: "This box's route id and route public key (base64url), for signing into the name directory. Modules only.",
      input: obj(),
      run: async (_, meta) => { only(meta, ["names"], "the route id"); return { route: route(), pub: Buffer.from(k().route.pub).toString("base64url") }; },
    });

    ctx.tool("relay.route.sign", {
      internal: true,
      description: "Sign a name-directory request with the route key. Only a message that begins vyre-names-v1, a newline and this box's own route is signed. Modules only.",
      input: obj({ message: str }, ["message"]),
      run: async (input, meta) => {
        only(meta, ["names"], "signing with the route key");
        const msg = Buffer.from(String(input.message || ""), "base64url");
        if (!msg.subarray(0, `vyre-names-v1\n${route()}\n`.length).equals(Buffer.from(`vyre-names-v1\n${route()}\n`))) throw fail("bad_input", "only a name-directory message for this box's own route is signed");
        const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(k().route.priv)]), format: "der", type: "pkcs8" });
        return { sig: crypto.sign(null, msg, priv).toString("base64url") };
      },
    });

    // The install line's own boot: the code arrives in VYRE_CODE (never argv), is taken once and
    // removed from this process's environment so no child inherits it.
    const bootCode = (seam.env || process.env).VYRE_CODE;
    if (bootCode) {
      if (!seam.env) delete process.env.VYRE_CODE;
      beginSetup(String(bootCode)).catch(e => ctx.log(`relay: setup code not used: ${/** @type {Error} */ (e).message}`));
    }

    return { async stop() { stopLink(); if (setup) clearTimeout(setup.timer); for (const set of live.values()) for (const ch of set) ch.close(1001, "box stopping"); live.clear(); } };
  },
};
