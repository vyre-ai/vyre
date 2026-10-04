// @ts-check
// companion: a local core that joins the box as a companion of the desktop app already paired on the same machine, with no second
// passkey prompt. The app's own device key vouches for the core: the app calls link.companion.pair over its relay channel with a
// presence proof, which the presence layer already makes cover the whole call (tool, input, time, nonce) and checks against the key
// enrolled for that device, so the proof IS the countersign. The core's own public key is in the input and is registered; the core
// is authenticated by its own private key, never by a secret the box hands to the app. Two separate keys in two separate processes.
//
// Inside 15 minutes of the app's own pairing, and with no companion of that kind yet, the box approves at once. Otherwise it holds a
// request and the person approves it with one tap on a card (no Touch ID). A companion is valid only while its parent device is live
// and untouched by removal, checked on every use, so the order of two removals never matters. A companion has link scope only.
// Not usable until a transport authenticates the core's key (v0.2.3: over the tailnet, as the Mac's link does).

import { deviceIdOf } from "../../lib/caller.js";
import crypto from "node:crypto";

export const WINDOW_MS = 15 * 60_000;
const SKEW_MS = 2 * 60_000, ATTEMPTS = 5, ATTEMPT_WINDOW = 10 * 60_000, PENDING_MS = 5 * 60_000, KIND = "core";
export const TOKEN_TAG = "vyre-companion-call";
const MAX_NONCES = 20_000;
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const fail = (code, message) => Object.assign(new Error(message), { code });

/** A short fingerprint of a core's public key, the same two-group form the box shows everywhere. @param {string} core */
export function coreFingerprint(core) {
  const d = crypto.createHash("sha256").update(Buffer.from(core, "base64url")).digest("base64url").toLowerCase().replace(/[^a-z2-7]/g, "").slice(0, 8);
  return `${d.slice(0, 4)} ${d.slice(4)}`;
}

/** JSON with every object's keys sorted: both ends hash the same bytes. @param {any} v @returns {string} */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

/**
 * What a call's token signs for its input: sha256 (base64url) of the canonical JSON, with `data` (an upload chunk's raw bytes) replaced by
 * its own sha256 so a megabyte chunk is hashed as bytes, never as JSON. A string `data` counts as its UTF-8 bytes.
 * @param {any} input
 */
export function inputDigest(input) {
  const i = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : input;
  if (i && typeof i === "object" && "data" in i) {
    const d = i.data;
    i.data = { sha256: crypto.createHash("sha256").update(typeof d === "string" ? Buffer.from(d, "utf8") : Buffer.from(d ?? [])).digest("base64url") };
  }
  return crypto.createHash("sha256").update(canonical(i ?? {})).digest("base64url");
}

/**
 * The bytes a companion core signs for one call. Tool and input digest are bound, so a token cannot be moved to another call, and the box id
 * is bound, so it cannot be replayed at another box.
 * @param {{ box: string, companion: string, ts: number|string, nonce: string, tool: string, input: any }} o
 */
export const tokenMessage = o => Buffer.from([TOKEN_TAG, o.box, o.companion, String(o.ts), o.nonce, o.tool, inputDigest(o.input)].join("\n"));

/** A box's id as a companion core pins it: sha256 (base64url) of the box's public key, SPKI base64url. @param {string} pub */
export const boxId = pub => crypto.createHash("sha256").update(String(pub)).digest("base64url");

/**
 * @param {any} ctx
 * @param {{ maxNonces?: number, box?: () => { pub: string, name?: string|null } | null, db: any, now: () => number, deviceInfo: (id: string) => Promise<{ kind: string, trusted: boolean, pairedAt: number, presenceKey: string|null, removed: boolean } | null> }} o
 */
export function companionSide(ctx, { db, now, deviceInfo, box = () => null, maxNonces = MAX_NONCES }) {
  /** Spent nonces live in memory only, so a token made before this start is refused: a captured one cannot be replayed after a restart. */
  const started = now();
  /** @type {Map<string, number[]>} */
  const attempts = new Map();
  /** @type {Set<string>} */
  const nonces = new Set();
  /** Call-token nonces per companion, kept as long as a token's timestamp could still be accepted; one companion's calls never push out another's. @type {Map<string, Map<string, number>>} */
  const used = new Map();
  /** @type {null | { id: string, device: string, name: string, core: string, fp: string, nonce: string, expires: number }} */
  let pending = null;

  const deviceOf = (caller, meta) => {
    const c = String(caller || "");
    const id = deviceIdOf(c);
    if (id === null || !/^[a-z2-7]{16}$/.test(id) || (meta && meta.agent)) throw fail("denied", "a companion is requested by a paired desktop app over its own relay channel");
    return id;
  };
  /** The box's own key as the core pins it at pairing, so a later call is never trusted by name or address alone. */
  const boxAnswer = () => { const b = box(); return b && b.pub ? { box: { pub: b.pub, id: boxId(b.pub) } } : {}; };
  const refuse = (device, reason) => {
    try { ctx.events.emit("companion.refused", { device, reason }); } catch {}
    return fail("refused", reason);
  };
  const tooMany = device => {
    const t = now(), list = (attempts.get(device) || []).filter(x => t - x < ATTEMPT_WINDOW);
    list.push(t); attempts.set(device, list);
    return list.length > ATTEMPTS;
  };
  const live = row => db.prepare("SELECT id FROM link_peers WHERE kind = 'companion' AND parent = ? AND id != ?").all(row.parent, row.id);

  /** A companion is valid only while its own row is there AND its parent device is live; evaluated on every use. @param {string} id */
  async function valid(id) {
    const row = /** @type {any} */ (db.prepare("SELECT id, parent FROM link_peers WHERE id = ? AND kind = 'companion'").get(id));
    if (!row) return null;
    const parent = await deviceInfo(String(row.parent));
    if (!parent || parent.removed) return null;
    // Never above its parent: an untrusted or limited parent makes an equally limited companion, now, not as it was at approval.
    return { id: row.id, parent: String(row.parent), trusted: parent.trusted, kind: parent.kind };
  }

  function insert({ device, name, core, approved, nonce }) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO link_peers (id, name, login, node, stable_id, key_hash, paired_at, last_seen, kind, parent, core_pub) VALUES (?, ?, NULL, NULL, NULL, ?, ?, NULL, 'companion', ?, ?)")
      .run(id, name, sha(crypto.randomBytes(32)), now(), device, core);
    // key_hash is a random value nobody holds: a companion has no bearer key. It is authenticated by its core's own private key (the transport's job).
    ctx.events.emit("companion.paired", { device, companion: id, fingerprint: coreFingerprint(core), approved, nonce });
    return id;
  }

  ctx.tool("link.companion.pair", {
    callers: ["deck", "tailnet", "device", "space", "agent"],
    description: "A paired desktop app asks the box to accept its local core as a companion: { core (its P-256 public key, base64url), name, nonce, ts }. Called over the app's own relay channel with a presence proof from the app device's key, which is the countersign. Answers { id, approved: window } inside 15 minutes of the app's pairing with no companion yet, else { pending, approved: false } for the person's one tap.",
    input: { type: "object", properties: { core: { type: "string" }, name: { type: "string" }, nonce: { type: "string" }, ts: { type: "number" } }, required: ["core", "nonce", "ts"] },
    presence: { when: () => true, summary: async i => `Let this app's local core join this box as its companion (key ${i && typeof i.core === "string" ? coreFingerprint(i.core) : "unknown"})` },
    run: async ({ core, name, nonce, ts }, meta = {}) => {
      const device = deviceOf(meta.caller, meta);
      if (tooMany(device)) throw refuse(device, "too many companion attempts from this device; wait a few minutes");
      const info = await deviceInfo(device);
      // Only a desktop app device. A web device (the hosted app) never mints a companion.
      if (!info || info.removed || info.kind !== "app") throw refuse(device, "only a paired desktop app can ask for a companion");
      if (!meta.person) throw refuse(device, "no person session on this device");
      if (!meta.presence || !info.presenceKey || String(meta.presence.keyId) !== String(info.presenceKey)) throw refuse(device, "the proof is not from this device's own key");
      if (typeof core !== "string" || !/^[A-Za-z0-9_-]{60,200}$/.test(core)) throw refuse(device, "the core's key is not a public key this box accepts");
      if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || nonces.has(`${device}:${nonce}`)) throw refuse(device, "the nonce is missing or was already used");
      if (!Number.isFinite(ts) || Math.abs(now() - ts) > SKEW_MS) throw refuse(device, "the timestamp is outside the allowed two minutes");
      nonces.add(`${device}:${nonce}`);
      if (nonces.size > 5000) nonces.clear();
      const label = String(name || "this PC's core").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 64) || "this PC's core";
      const inWindow = now() - info.pairedAt <= WINDOW_MS;
      const have = db.prepare("SELECT id FROM link_peers WHERE kind = 'companion' AND parent = ?").all(device);
      if (inWindow && !have.length) return { id: insert({ device, name: label, core, approved: "window", nonce }), approved: "window", fingerprint: coreFingerprint(core), ...boxAnswer() };
      // Outside the window, or a second companion: one pending request at a time, for the person's one tap.
      if (pending && pending.expires > now()) throw refuse(device, "another companion request is already waiting for the person");
      pending = { id: crypto.randomBytes(12).toString("base64url"), device, name: label, core, fp: coreFingerprint(core), nonce, expires: now() + PENDING_MS };
      ctx.events.emit("companion.requested", { request: pending.id, device, name: label, fingerprint: pending.fp, reason: inWindow ? "a second companion" : "outside the pairing window" });
      return { pending: pending.id, approved: false, fingerprint: pending.fp };
    },
  });

  ctx.tool("link.companion.approve", {
    description: "The person approves the waiting companion request with one tap on its card (the app device's name and the core's fingerprint), no Touch ID. Answers { id }.",
    input: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
    run: async ({ request }) => {
      if (!pending || pending.id !== String(request) || pending.expires <= now()) throw fail("not_found", "no companion request is waiting with that id");
      const p = pending; pending = null;
      const info = await deviceInfo(p.device);
      if (!info || info.removed || info.kind !== "app") throw fail("not_found", "that app device is gone");
      const have = db.prepare("SELECT id FROM link_peers WHERE kind = 'companion' AND parent = ?").all(p.device);
      if (have.length) db.prepare("DELETE FROM link_peers WHERE kind = 'companion' AND parent = ?").run(p.device);
      return { id: insert({ device: p.device, name: p.name, core: p.core, approved: "tap", nonce: p.nonce }), ...boxAnswer() };
    },
  });

  ctx.tool("link.companion.remove", {
    description: "Revoke a companion by id. The app device it belongs to stays.",
    input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async ({ id }) => {
      const row = /** @type {any} */ (db.prepare("SELECT id, parent FROM link_peers WHERE id = ? AND kind = 'companion'").get(String(id)));
      if (!row) throw fail("not_found", "no such companion");
      db.prepare("DELETE FROM link_peers WHERE id = ?").run(row.id);
      ctx.events.emit("companion.removed", { device: row.parent, companion: row.id, why: "revoked" });
      return { removed: row.id };
    },
  });

  ctx.tool("link.companion.list", {
    description: "The companions and the waiting request: id, name, the app device it belongs to, whether it is valid now (its parent device is live), and its core's fingerprint.",
    input: { type: "object", properties: {} },
    run: async () => {
      const rows = /** @type {any[]} */ (db.prepare("SELECT id, name, parent, core_pub, paired_at FROM link_peers WHERE kind = 'companion' ORDER BY paired_at").all());
      const out = [];
      for (const r of rows) out.push({ id: r.id, name: r.name, device: r.parent, fingerprint: coreFingerprint(r.core_pub), pairedAt: r.paired_at, valid: Boolean(await valid(r.id)) });
      return { companions: out, pending: pending && pending.expires > now() ? { request: pending.id, device: pending.device, name: pending.name, fingerprint: pending.fp, expires: pending.expires } : null };
    },
  });

  /**
   * One call's proof, checked every time and on every call and chunk: the token is
   *   c1.<companion id>.<ts ms>.<nonce>.<signature>
   * where the signature is ECDSA P-256 over SHA-256 (raw r||s, base64url) of tokenMessage(), made by the core's own private key. The box
   * checks that the companion row exists, that its parent app device is live and trusted right now (removed or limited: refused), that the
   * time is within two minutes and the nonce is new, and the signature against the core's registered key. Nothing about the tailnet peer
   * counts toward who the core is. Answers { id, name, device } or throws.
   * @param {{ token: unknown, tool: string, input?: any }} o
   */
  async function verifyCall({ token, tool, input }) {
    const deny = why => fail("denied", `companion proof refused: ${why}`);
    const m = /^c1\.([0-9a-f-]{36})\.(\d{1,16})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{80,120})$/.exec(String(token || ""));
    if (!m) throw deny("not a companion token");
    const [, id, tsText, nonce, sig] = m, ts = Number(tsText), t = now();
    if (Math.abs(t - ts) > SKEW_MS) throw deny("the time is outside two minutes");
    if (ts < started) throw deny("it was made before this box started; sign a fresh one");
    const row = /** @type {any} */ (db.prepare("SELECT id, name, parent, core_pub FROM link_peers WHERE id = ? AND kind = 'companion'").get(id));
    if (!row) throw deny("no such companion");
    const parent = await valid(id);
    if (!parent) throw deny("its app device is gone");
    if (!parent.trusted) throw deny("its app device is limited");
    const b = box();
    if (!b || !b.pub) throw deny("this box has no key to bind a proof to");
    let ok = false;
    try {
      ok = crypto.verify("sha256", tokenMessage({ box: boxId(b.pub), companion: id, ts, nonce, tool, input }),
        { key: crypto.createPublicKey({ key: Buffer.from(row.core_pub, "base64url"), format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
    } catch { ok = false; }
    if (!ok) throw deny("the signature is not from this companion's key, or not for this call");
    // A nonce is spent only by a valid signature, so a stranger cannot fill the table; entries live as long as their timestamps could still pass.
    let mine = used.get(id);
    if (!mine) used.set(id, mine = new Map());
    for (const [k, at] of mine) if (t - at > 2 * SKEW_MS) mine.delete(k);
    if (mine.has(nonce)) throw deny("the nonce was already used");
    if (mine.size >= maxNonces) throw deny("too many calls in flight for this companion; try again in a moment");
    mine.set(nonce, ts);
    return { id: row.id, name: row.name, device: parent.parent };
  }

  ctx.tool("link.companion.hello", {
    callers: ["tailnet", "device", "space", "agent"],
    description: "A paired companion core checks in, proving its own key: { token } signed for this tool with an empty input. Answers { paired: true, companion, device, box: { name, pub, id } }, or refuses. The box answers nothing the core could not already pin at pairing.",
    input: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
    run: async ({ token }) => {
      const v = await verifyCall({ token, tool: "link.companion.hello", input: {} });
      const b = box();
      return { paired: true, companion: v.id, device: v.device, box: { name: (b && b.name) || null, ...(b && b.pub ? { pub: b.pub, id: boxId(b.pub) } : {}) } };
    },
  });

  ctx.tool("link.companion.verify", {
    internal: true,
    description: "Another module asks whether this call was signed by a live companion core: { token, tool, input } with the input as the core signed it (the token field removed). Answers { id, name, device } or an error. Internal: modules only.",
    input: { type: "object", properties: { token: { type: "string" }, tool: { type: "string" }, input: {} }, required: ["token", "tool"] },
    run: async ({ token, tool, input }) => verifyCall({ token, tool, input }),
  });

  /** A parent device that is gone takes its companions with it: once at startup, and on its removal, as a tidy-up; validity never depends on it. */
  async function reconcile() {
    for (const r of /** @type {any[]} */ (db.prepare("SELECT id, parent FROM link_peers WHERE kind = 'companion'").all())) {
      const parent = await deviceInfo(String(r.parent));
      if (!parent || parent.removed) { db.prepare("DELETE FROM link_peers WHERE id = ?").run(r.id); try { ctx.events.emit("companion.removed", { device: r.parent, companion: r.id, why: "its app device was removed" }); } catch {} }
    }
  }
  const off = ctx.events.on("device.removed", () => { reconcile().catch(() => {}); });
  setImmediate(() => { reconcile().catch(() => {}); });
  return { valid, reconcile, verifyCall, stop() { try { off(); } catch {} } };
}
