// @ts-check
// relay: a second way to reach the box besides Tailscale (ADR 0026). The box dials out to a
// relay; a device paired by QR code meets it there and runs a Noise IK handshake with the box's
// key. The box admits only devices it paired, names each one `device:<id>`, and hands its
// requests to vyred's router, where it is the owner on their own device, like `tailnet:<owner>`.
// Presence is unchanged: being a person lets a device ask, never skips the proof.
//
// Off until the first pairing. Keys live in ~/.vyre/relay/keys.json (0600) and never leave the
// box: box.key is the Noise static key the QR carries, route.key proves the route to the relay.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as config from "../config/index.js";
import { keyPair } from "./noise.js";
import { newRouteKey, routeId, base32 } from "./wire.js";
import { relayLink } from "./link.js";
import { bridge } from "./bridge.js";
import { pairUrl } from "./pairing.js";

export const DEFAULT_RELAY = "wss://relay.vyre.run";
const PAIR_TTL = 10 * 60_000;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;
const AGENT_CLAIM = /(?:^|[\s:])agent:/;

export const MIGRATIONS = [
  `CREATE TABLE relay_devices (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, pub TEXT NOT NULL, presence_key TEXT,
     paired_at INTEGER NOT NULL, last_seen INTEGER, removed_at INTEGER
   );`,
];

/** The id a device is known by: the first 16 base32 characters of sha256 of its static key. */
export const deviceId = pub => base32(crypto.createHash("sha256").update(pub).digest()).slice(0, 16);

const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const str = { type: "string" };
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const fail = (code, message) => Object.assign(new Error(message), { code });

/** The box's relay keys, made on first use. */
export function loadKeys(root) {
  const dir = path.join(root, "relay");
  const file = path.join(dir, "keys.json");
  try {
    const k = JSON.parse(fs.readFileSync(file, "utf8"));
    const box = keyPair(Buffer.from(k.box, "base64url"));
    const routePriv = Buffer.from(k.route, "base64url");
    const routePub = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), routePriv]), format: "der", type: "pkcs8" }))
      .export({ format: "der", type: "spki" }).subarray(-32);
    return { box, route: { priv: routePriv, pub: Buffer.from(routePub) } };
  } catch (e) {
    if (/** @type {any} */ (e).code !== "ENOENT") throw new Error(`relay keys unreadable (${file}): ${/** @type {Error} */ (e).message}`);
  }
  const box = keyPair(), route = newRouteKey();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, box: box.priv.toString("base64url"), route: route.priv.toString("base64url") }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { box, route };
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
    const settings = () => ({ enabled: false, url: DEFAULT_RELAY, ...(ctx.config.relay || {}) });
    const save = patch => config.save({ relay: patch }, ctx.paths.root, ctx.config);
    /** @type {ReturnType<typeof loadKeys> | null} */
    let keys = null;
    const k = () => (keys = keys || loadKeys(ctx.paths.root));
    const route = () => routeId(k().route.pub);
    const boxName = () => (ctx.config.network && ctx.config.network.name) || os.hostname().split(".")[0];

    /** One live pairing at a time: its secret's hash, when it ends, and whether it is the first device's. */
    /** @type {{ hash: Buffer, exp: number, first: boolean } | null} */
    let pairing = null;
    /** Open channels per device id, so removing a device closes it at once. */
    /** @type {Map<string, Set<any>>} */
    const live = new Map();

    const active = () => /** @type {any[]} */ (db.prepare("SELECT id, name, pub, presence_key, paired_at, last_seen FROM relay_devices WHERE removed_at IS NULL ORDER BY paired_at").all());
    const personExists = () => active().length > 0 || Boolean(ctx.config.network && ctx.config.network.owner);

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
        const p = pairing;
        const good = p && p.exp > now() && crypto.timingSafeEqual(sha(hello.pair), p.hash);
        if (!good) throw new Error("this QR code has expired or was already used; make a new one on the box");
        if (p.first && personExists()) throw new Error("this box already has a device; if that was not you, remove it from Settings, Devices");
        pairing = null;
        const name = typeof hello.name === "string" && NAME.test(hello.name.trim()) ? hello.name.trim() : "a device";
        let presenceKey = null, presence = { enrolled: false, reason: "no presence key offered" };
        const pk = hello.presenceKey;
        if (pk && typeof pk.public_key === "string") {
          const r = await ctx.call("presence.enroll", { kind: "device", name, public_key: pk.public_key, alg: pk.alg ?? -7 });
          if (r && r.data && (r.data.keyId || r.data.id)) { presenceKey = String(r.data.keyId || r.data.id); presence = { enrolled: true, reason: "" }; }
          else presence = { enrolled: false, reason: (r && r.error && r.error.message) || "presence would not enroll this key" };
        }
        db.prepare(`INSERT INTO relay_devices (id, name, pub, presence_key, paired_at, last_seen, removed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, pub = excluded.pub, presence_key = excluded.presence_key, paired_at = excluded.paired_at, last_seen = excluded.last_seen, removed_at = NULL`)
          .run(id, name, pub.toString("base64url"), presenceKey, now(), now());
        ctx.events.emit("device.paired", { id, name });
        return { v: 1, box: { name: boxName() }, device: id, paired: true, presence };
      }
      const row = /** @type {any} */ (db.prepare("SELECT id, pub FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (!row || !crypto.timingSafeEqual(Buffer.from(row.pub, "base64url"), pub)) throw new Error("not a paired device");
      db.prepare("UPDATE relay_devices SET last_seen = ? WHERE id = ?").run(now(), id);
      return { v: 1, box: { name: boxName() }, device: id };
    }

    let handle = null, upgrade = null;
    function onchannel(channel, { reply }) {
      const id = String(reply.device);
      const row = /** @type {any} */ (db.prepare("SELECT name FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
      if (!row) { channel.close(4401, "device removed"); return; }
      if (!handle) handle = ctx.handler({});
      const peer = { node: row.name, stableId: id, login: null, tags: [], caps: {}, kind: "device" };
      bridge(channel, { handler: handle, caller: `device:${id}`, peer, upgrade: () => (upgrade = upgrade || ctx.upgrader({})), log: m => ctx.log(m) });
      const set = live.get(id) || new Set();
      set.add(channel);
      live.set(id, set);
      const closed = channel.onclose;
      channel.onclose = reason => { closed(reason); set.delete(channel); };
    }

    if (settings().enabled) startLink();

    // ---- tools ----

    const view = d => ({ id: d.id, name: d.name, pairedAt: d.paired_at, lastSeen: d.last_seen, presence: Boolean(d.presence_key), online: (live.get(d.id)?.size || 0) > 0 });

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

    ctx.tool("relay.devices.list", {
      description: "Devices paired through the relay: id, name, when paired and last seen, whether presence is enrolled, and whether it is connected now.",
      input: obj(),
      run: async (_, meta = {}) => { owner(meta.caller, meta, "the device list"); return { devices: active().map(view) }; },
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
        const row = /** @type {any} */ (db.prepare("SELECT presence_key FROM relay_devices WHERE id = ? AND removed_at IS NULL").get(id));
        if (!row) throw fail("not_found", `no paired device ${id}`);
        db.prepare("UPDATE relay_devices SET removed_at = ? WHERE id = ?").run(now(), id);
        for (const ch of live.get(id) || []) ch.close(4401, "device removed");
        live.delete(id);
        if (row.presence_key) await ctx.call("presence.remove", { id: row.presence_key }).catch(() => null);
        ctx.events.emit("device.removed", { id });
        return { removed: id };
      },
    });

    return { async stop() { stopLink(); for (const set of live.values()) for (const ch of set) ch.close(1001, "box stopping"); live.clear(); } };
  },
};
