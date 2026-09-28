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
import { routeId, base32, TICKET_BYTES, TICKET_TTL, ticketDerive, ticketMac } from "./wire.js";
import { relayLink } from "./link.js";
import { bridge } from "./bridge.js";
import { pairUrl, parsePairUrl } from "./pairing.js";
import { knownBuild, findRelease, newestRelease } from "./releases.js";
import { loadKeys } from "./keys.js";
import { redeem } from "./redeem.js";

export { loadKeys } from "./keys.js";

export const DEFAULT_RELAY = "wss://relay.vyre.run";
const PAIR_TTL = 10 * 60_000;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
const AGENT_CLAIM = /(?:^|[\s:])agent:/;
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
 * (ADR 0040) exists to hold it instead: `relay.join` (this device's own identity key,
 * relay-device/key.json, core/relay/redeem.js) and `relay.pair.ticket` (a pairing whose secret and
 * MAC key derive from a ticket held only in this box's process, same as relay.pair.start's own
 * secret in relay/keys.json). All of it sits at the person's own login uid today, readable and
 * writable by any process at that uid - the same gap that already keeps relay hosting off by
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
    // set only once a name is actually claimed) - not boxName()'s fallback chain, since a display
    // name is not necessarily a real, resolvable handle. Null when nothing is claimed yet: the
    // lead's 28 Sep ask (so a phone can offer <handle>.vyre.run after pairing, without a guess).
    const boxHandle = () => {
      const h = ctx.config.name;
      return typeof h === "string" && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/i.test(h) ? h.slice(0, 32) : null;
    };

    /** One live pairing at a time: its secret's hash, when it ends, and whether it is the first device's. */
    /** @type {{ hash: Buffer, exp: number, first: boolean } | null} */
    let pairing = null;
    /** Live ticket-minted pairings (ADR 0037), any number at once, each single-use: the pairing
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

    const active = () => /** @type {any[]} */ (db.prepare("SELECT id, name, pub, presence_key, paired_at, last_seen, kind, release, manifest, trusted, node_id, node_name, last_path, path_at, rtt FROM relay_devices WHERE removed_at IS NULL ORDER BY paired_at").all());
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
      if ((meta && meta.agent) || AGENT_CLAIM.test(c)) throw fail("denied", `"${c}" is an agent; ${what} is the owner's`);
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
      if (hello && typeof hello.pair === "string") {
        const match = takeLiveSecret(hello.pair);
        if (!match) throw new Error("this pairing code has expired or was already used; make a new one on the box");
        if (match.first && personExists()) throw new Error("this box already has a device; if that was not you, remove it from Settings, Devices");
        const name = promptSafe(typeof hello.name === "string" ? hello.name.trim() : "", "a device", 64);
        const kind = hello.kind === "web" ? "web" : "app";
        const release = typeof hello.release === "string" && BUILD.test(hello.release) ? hello.release : null;
        const manifest = typeof hello.manifest === "string" && /^[a-f0-9]{64}$/.test(hello.manifest) ? hello.manifest : null;
        let presenceKey = null, presence = { enrolled: false, reason: "no presence key offered" };
        const pk = hello.presenceKey;
        if (pk && typeof pk.public_key === "string") {
          const r = await ctx.call("presence.enroll", { kind: "device", name, public_key: pk.public_key, alg: pk.alg ?? -7 });
          if (r && r.data && (r.data.keyId || r.data.id)) { presenceKey = String(r.data.keyId || r.data.id); presence = { enrolled: true, reason: "" }; }
          else presence = { enrolled: false, reason: (r && r.error && r.error.message) || "presence would not enroll this key" };
        }
        db.prepare(`INSERT INTO relay_devices (id, name, pub, presence_key, paired_at, last_seen, removed_at, kind, release, manifest, trusted) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, pub = excluded.pub, presence_key = excluded.presence_key, paired_at = excluded.paired_at, last_seen = excluded.last_seen, removed_at = NULL,
            kind = excluded.kind, release = excluded.release, manifest = excluded.manifest, trusted = 0`)
          .run(id, name, pub.toString("base64url"), presenceKey, now(), now(), kind, release, manifest);
        // The pairing notice: every surface shows it with a one-tap removal (ADR 0026 section 6).
        // Carries the new device's own key fingerprint (reviewer, 28 Sep LOW) so the notice reads
        // the same short form ("a1b2 c3d4") as every other Touch ID / confirm screen that shows one.
        ctx.events.emit("device.paired", { id, name, kind, fingerprint: keyFingerprint(pub), ...(kind === "web" ? { release, build: knownBuild(release, manifest) ? "known" : "unknown" } : {}) });
        // The scan-to-pair screen's own event (ADR 0037, the lead 28 Sep): only for a ticket
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

    let handle = null, webHandle = null, upgrade = null;
    function onchannel(channel, { reply }) {
      const id = String(reply.device);
      const row = /** @type {any} */ (db.prepare("SELECT name, kind, trusted FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (!row) { channel.close(4401, "device removed"); return; }
      if (!handle) handle = ctx.handler({});
      if (!webHandle) webHandle = ctx.handler({ tool: name => !WEB_DENY.test(name) });
      const limited = row.kind === "web" && !row.trusted;
      const peer = { node: row.name, stableId: id, login: null, tags: [], caps: {}, kind: "device", ...(row.kind === "web" ? { web: true } : {}) };
      bridge(channel, { handler: limited ? webHandle : handle, caller: `device:${id}`, peer, upgrade: () => (upgrade = upgrade || ctx.upgrader({})), log: m => ctx.log(m) });
      const set = live.get(id) || new Set();
      set.add(channel);
      live.set(id, set);
      const closed = channel.onclose;
      channel.onclose = reason => { closed(reason); set.delete(channel); };
    }

    if (settings().enabled) startLink();

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
      const row = /** @type {any} */ (db.prepare("SELECT presence_key FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (!row) return false;
      db.prepare("UPDATE relay_devices SET removed_at = ? WHERE id = ?").run(now(), id);
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
        return { enabled: Boolean(s.enabled), url: s.url, connected: Boolean(link && link.connected), route: s.enabled || keys ? route() : null,
          devices: active().length, open: link ? link.open : 0, pairing: pairing && pairing.exp > now() ? { expiresAt: pairing.exp } : null };
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

    // Scan-to-pair, "Wink" in copy (ADR 0037): a Vyre code carries only a compact 64-bit ticket,
    // not a full offer, so a phone that scans it resolves the offer from the relay instead of
    // reading it straight off the code. Everything the relay ever sees is a one-way derivation of
    // the ticket under its own tag (core/relay/wire.js): a locator to store the record under, and
    // a MAC key that authenticates it, so the relay can neither redeem the pairing itself (it
    // never learns the secret) nor substitute its own record (it never learns the MAC key). The
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
      const record = JSON.stringify({ v: 1, name: boxName(), handle: boxHandle(), relay: settings().url, route: route(), box: k().box.pub.toString("base64url"), exp });
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
      description: "This Vyre becomes a device of another box, redeeming a one-time pairing code minted there (relay.pair.start or onboard.join{action:\"relay\"}). One redemption: the channel closes once paired, then this tool returns what the other box said (its name, this device's id, whether presence enrolled). becomeDevice, when true, flips this machine to \"device\" once paired (onboard.machine), the shape onboard.join{action:\"verify\",becomeDevice} uses on the Tailscale path, so the onboarding card calls the same flag either way. Does not keep a connection open; that is not built yet. A pasted URL that is not a real Vyre pairing code is refused before any prompt. Not available on a Mac yet: see vyre-core (ADR 0040).",
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
        try { paired = await redeem(url, { root: ctx.paths.root, name }); }
        catch (e) { throw fail("bad_input", /** @type {Error} */ (e).message); }
        if (becomeDevice) await ctx.call("onboard.machine", { machine: "device" }).catch(() => {});
        return paired;
      },
    });

    ctx.tool("relay.devices.list", {
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

    return { async stop() { stopLink(); for (const set of live.values()) for (const ch of set) ch.close(1001, "box stopping"); live.clear(); } };
  },
};
