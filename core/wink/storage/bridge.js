// @ts-check
// The Wink side of a bridged drive: a drive that only one device on its network can reach (a network drive in the office, a disk on a Mac mini) is
// offered to the space by that device, and the space's home uses it through a Wink call. The pool engine (work/sealing: kernel/storage/bridge.js,
// devices.js) owns the frames, the signing and the backend; this file is the transport and the pairing around them. Nothing here imports the engine:
// `createBridge`, `backendFor` and `linkTo` are passed in, so there is no boundary edge.
//
//   device with the drive:  createBridgeEndpoint({ createBridge, secrets, ... }).handle(caller, input)  is the answer to the Wink call `wink.storage.bridge`
//   home:                   bridgeMakeBackend({ backendFor, secrets, linkTo })                          is the adapter's `makeBackend`
//   pairing:                pairFromHome(...) makes the secret on the home and hands it once to the device, which keeps it with acceptDrive(...)
//
// The secret is 32 random bytes. It lives in the vault on both devices (item `wink-bridge-<offer>`) and nowhere else: not in the offer row, not in an
// event, not in a log line, not in a card. It crosses once, home to device, and never as a plain input of a call: the device first answers a one-time public
// key (`step: "open"`), the home seals the secret to it (X25519 + HKDF + AES-256-GCM, bound to the offer) and sends only the sealed box (`step: "seal"`).
// So any record of a call's inputs (a registry's call log, a trace) holds ciphertext that only the device's short-lived private key opens.
// Direction: the DEVICE holds one connection open to the home (hold.js) and the home calls back on it; the home never dials a drive's device.
// Chunks are ciphertext before they reach this code, so the frames carry nothing readable either way.
import { deviceIdOf } from "../../../lib/caller.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BRIDGE_TOOL = "wink.storage.bridge";
/** The home asks the device that has a drive to open and take the sealed secret (the device answers it down the connection it holds). */
export const ACCEPT_TOOL = "wink.storage.bridge.accept";
/** What a person runs on the home: use a drive through another device (the home picks the drive and names the device). */
export const DRIVE_TOOL = "wink.storage.bridge.drive";
/** The home asks a device that holds a connection what drives it can see from where it sits (the device answers down the connection; the home lists them beside its own). */
export const SCAN_TOOL = "wink.storage.bridge.scan";
/** Bodies travel as base64 in a JSON call (peer-wire carries up to 32 MB a message). The pool's chunks are far smaller; this stops a frame that could not fit. */
export const MAX_FRAME_BODY = 20 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * The bridge secrets, in the vault of this device.
 * @param {{ vault: { put(o: { name: string, fields: Record<string, string>, description: string }): Promise<void>, fetch(name: string, field?: string): Promise<string>, remove(name: string): Promise<void> },
 *   random?: (n: number) => Buffer }} o
 */
export function createBridgeSecrets({ vault, random = crypto.randomBytes }) {
  const name = (/** @type {string} */ offer) => { if (!ID.test(String(offer))) throw err("bad_input", "That storage id is not valid."); return `wink-bridge-${offer}`; };
  return {
    /** Make a new secret for an offer and keep it. Returns it once, for the enrolment call; a second make replaces the first. @param {string} offer */
    async make(offer) {
      const secret = random(32).toString("base64url");
      await vault.put({ name: name(offer), fields: { secret }, description: "Shared secret for a drive reached through another device (made by Vyre)" });
      return secret;
    },
    /** Keep a secret that was made elsewhere. @param {string} offer @param {string} secret */
    async keep(offer, secret) {
      if (typeof secret !== "string" || secret.length < 32 || secret.length > 128) throw err("bad_input", "That secret is not the right size.");
      await vault.put({ name: name(offer), fields: { secret }, description: "Shared secret for a drive reached through another device (made by Vyre)" });
    },
    /** @param {string} offer @returns {Promise<string | null>} */
    async get(offer) { try { return (await vault.fetch(name(offer), "secret")) || null; } catch { return null; } },
    /** @param {string} offer */
    async remove(offer) { await vault.remove(name(offer)).catch(() => {}); },
  };
}

/**
 * The real path of a path that may not exist yet: the real path of its nearest existing ancestor with the missing names put back. A symlink (also one that
 * points nowhere) anywhere in it is followed, never trusted, so a lexical `startsWith` on the result means what it says. A dangling link is refused.
 * @param {string} p
 */
export function realOf(p) {
  /** @type {string[]} */ const rest = [];
  let cur = path.resolve(String(p));
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); }
    catch (e) {
      const code = /** @type {any} */ (e).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      let l = null; try { l = fs.lstatSync(cur); } catch { /* not there at all */ }
      if (l && l.isSymbolicLink()) throw err("denied", "That folder is a link that leads nowhere.");
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(String(p));
      rest.push(path.basename(cur)); cur = up;
    }
  }
}
/** Is a real path one of the real roots or below one? @param {string} x @param {string[]} roots */
export const within = (x, roots) => roots.some(b => x === b || x.startsWith(b.endsWith(path.sep) ? b : b + path.sep));

/**
 * A drive folder that must stay under the real roots. `check()` is run before every use: the real path of the folder must still be itself (no link on the way or
 * at the end), still lie under a real root, and still be the same directory (device and inode) it was when it was opened. The folder is opened with O_NOFOLLOW and
 * O_DIRECTORY, so a link swapped in for the last name between the check and the open is refused by the kernel, and what was opened is compared with what was checked.
 * `hooks.afterCheck` runs between the check and the open (tests swap a folder there).
 * @param {{ dir: string, roots: string[], hooks?: { afterCheck?: () => void } }} o
 * @returns {{ real: string, check: () => void }}
 */
export function rootedDir({ dir, roots, hooks = {} }) {
  const realRoots = roots.map(r => { try { return realOf(r); } catch { return ""; } }).filter(Boolean);
  const deny = () => err("denied", "That folder is not one this device shares drives from.");
  const real = realOf(dir);
  if (!within(real, realRoots)) throw deny();
  try { if (fs.lstatSync(real).isSymbolicLink()) throw deny(); } catch (e) { if (/** @type {any} */ (e).code === "denied") throw e; }
  hooks.afterCheck?.();
  /** @type {{ dev: number, ino: number } | null} */ let id = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(real, flags);
    try { const f = fs.fstatSync(fd), n = fs.statSync(real); if (f.dev !== n.dev || f.ino !== n.ino) throw deny(); id = { dev: f.dev, ino: f.ino }; }
    finally { fs.closeSync(fd); }
  } catch (e) {
    const code = /** @type {any} */ (e).code;
    if (code === "ENOENT") id = null; // not made yet: the engine makes it, and check() looks again before every use
    else throw code === "denied" ? e : deny();
  }
  if (id && realOf(real) !== real) throw deny();
  const check = () => {
    if (realOf(real) !== real || !within(realOf(real), realRoots)) throw deny();
    let l; try { l = fs.lstatSync(real); } catch (e) { if (/** @type {any} */ (e).code === "ENOENT" && !id) return; throw deny(); }
    if (l.isSymbolicLink() || !l.isDirectory()) throw deny();
    if (id) { if (l.dev !== id.dev || l.ino !== id.ino) throw deny(); } else id = { dev: l.dev, ino: l.ino };
  };
  return { real, check };
}

/**
 * The folder on THIS device that holds a drive's files: where it is mounted. A plugged-in disk has its path; a network drive is mounted under the
 * usual places by its share name. Returns null when this device does not have it (so it cannot serve it).
 * @param {{ mount?: string, path?: string, share?: string }} loc @param {{ kind?: string, exists?: (p: string) => boolean }} [o]
 */
export function localDriveDir(loc, o = {}) {
  const exists = o.exists || (p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  const share = String(loc.share || "").replace(/[^A-Za-z0-9 ._-]/g, "");
  const tries = [loc.mount, o.kind === "usb-disk" ? loc.path : undefined, share ? `/Volumes/${share}` : "", share ? `/mnt/${share}` : "", share ? `/media/${share}` : ""];
  for (const t of tries) if (t && exists(t)) return t;
  return null;
}

/**
 * The device with the drive: answers the home's Wink calls. Each offer it serves is registered with the one caller allowed to ask (the home's device
 * identity as the Wink connection reports it) and a check that the offer is still live and its grant holds. Anything else is refused before the engine
 * sees a frame.
 * @param {{ createBridge: (o: { dir: string, secret: string, capacity: number }) => { handle(f: any): Promise<{ status: number, body?: Buffer }> }, secrets: ReturnType<typeof createBridgeSecrets>,
 *   live?: (offer: string) => boolean | Promise<boolean>, log?: (m: string) => void }} o
 */
export function createBridgeEndpoint({ createBridge, secrets, live = () => true, log = () => {} }) {
  /** @type {Map<string, { caller: string, guard?: () => void | Promise<void>, bridge: { handle(f: any): Promise<{ status: number, body?: Buffer }> } }>} */
  const serving = new Map();
  return {
    /** Start serving an offer from a folder on this device, for one caller. `guard` runs before every frame is handled and throws when the folder is no longer where it was checked. @param {{ offer: string, dir: string, capacity: number, caller: string, guard?: () => void | Promise<void> }} o */
    async serve({ offer, dir, capacity, caller, guard }) {
      const secret = await secrets.get(offer);
      if (!secret) throw err("no_secret", "This device has no secret for that drive, so it cannot serve it.");
      if (deviceIdOf(caller) === null) throw err("bad_input", "Name the device that may ask, like device:dev_abc.");
      serving.set(offer, { caller, ...(guard ? { guard } : {}), bridge: createBridge({ dir, secret, capacity }) });
    },
    /** @param {string} offer */
    stop(offer) { serving.delete(offer); },
    has: (/** @type {string} */ offer) => serving.has(offer),
    /**
     * The Wink call. `caller` is the identity the connection proved, never anything in `input`.
     * @param {string} caller @param {{ offer: string, op: string, key?: string, ts: number, nonce?: string, sig: string, body?: string }} input
     * @returns {Promise<{ status: number, body?: string }>}
     */
    async handle(caller, input) {
      const s = input && typeof input.offer === "string" ? serving.get(input.offer) : undefined;
      if (!s) throw err("not_found", "This device is not serving that drive.");
      if (s.caller !== caller) { log("wink storage: a bridge call from a device that does not own the drive was refused"); throw err("denied", "Only the device the drive was offered to may use it."); }
      if (!(await live(input.offer))) throw err("denied", "That drive is no longer offered.");
      if (s.guard) await s.guard();
      if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > Math.ceil(MAX_FRAME_BODY * 4 / 3) + 4)) return { status: 413 };
      const body = input.body ? Buffer.from(input.body, "base64") : undefined;
      const r = await s.bridge.handle({ op: input.op, key: input.key, ts: input.ts, nonce: input.nonce, sig: input.sig, ...(body ? { body } : {}) });
      return { status: r.status, ...(r.body ? { body: r.body.toString("base64") } : {}) };
    },
  };
}

const sleepMs = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** Errors a retry cannot fix: the other side said no, or the call is wrong. */
const FINAL = new Set(["denied", "bad_input", "not_found", "no_secret", "no_room", "full"]);
const retryable = (/** @type {any} */ e) => !(e && (FINAL.has(String(e.code)) || /\b(400|401|403|404|413|507)\b/.test(String(e.message || ""))));

/**
 * Home side: `bridge.send(deviceId, offer)` of devices.js. `linkTo(deviceId)` returns the channel to that device ({ call(tool, input, opt) }): the connection
 * the device holds open to the home (hold.js `createHolds().linkTo`), never a dial to the device.
 * @param {{ linkTo: (device: string) => { call(tool: string, input?: any, opt?: { timeoutMs?: number }): Promise<any> }, timeoutMs?: number }} o
 */
export function makeBridgeSend({ linkTo, timeoutMs = 30_000 }) {
  return (/** @type {string} */ device, /** @type {{ id: string }} */ offer) => async (/** @type {{ op: string, key?: string, body?: Buffer, ts: number, nonce?: string, sig: string }} */ f) => {
    if (f.body && f.body.length > MAX_FRAME_BODY) return { status: 413 };
    const r = await linkTo(device).call(BRIDGE_TOOL, { offer: offer.id, op: f.op, key: f.key, ts: f.ts, nonce: f.nonce, sig: f.sig, ...(f.body ? { body: Buffer.from(f.body).toString("base64") } : {}) }, { timeoutMs });
    return { status: Number(r.status), ...(r.body ? { body: Buffer.from(r.body, "base64") } : {}) };
  };
}

/**
 * A backend (put, get, del, ping) that resumes. A chunk put is idempotent by key, so a put, get or del that times out or loses the connection is tried again
 * for the same key (signed again each time, so the frame's clock window holds), up to `attempts`, waiting `baseMs`, 2x, 4x between tries. One failed call
 * is not the drive going away: `ping` keeps answering the last good size through `grace` ms and `failures` failed looks in a row, and only then says it is down.
 * @template {{ put(k: string, v: any): Promise<any>, get(k: string): Promise<any>, del(k: string): Promise<any>, ping(): Promise<any> }} B
 * @param {B} backend
 * @param {{ attempts?: number, baseMs?: number, grace?: number, failures?: number, now?: () => number, sleep?: (ms: number) => Promise<void>, log?: (m: string) => void }} [o]
 * @returns {B & { stats: { retried: number, failedCalls: number, pingMisses: number } }}
 */
export function resilientBackend(backend, o = {}) {
  const attempts = o.attempts ?? 4, baseMs = o.baseMs ?? 500, grace = o.grace ?? 20_000, maxMiss = o.failures ?? 3, now = o.now || Date.now, sleep = o.sleep || sleepMs, log = o.log || (() => {});
  const stats = { retried: 0, failedCalls: 0, pingMisses: 0 };
  /** @type {{ at: number, v: any } | null} */ let lastGood = null;
  let miss = 0;
  const again = async (/** @type {string} */ what, /** @type {() => Promise<any>} */ run) => {
    let last;
    for (let n = 0; n < attempts; n++) {
      try { return await run(); }
      catch (e) {
        last = e;
        if (!retryable(e) || n === attempts - 1) break;
        stats.retried++; log(`wink storage: ${what} will be tried again (${String((/** @type {any} */ (e)).code || "failed")})`);
        await sleep(baseMs * 2 ** n);
      }
    }
    stats.failedCalls++;
    throw last;
  };
  return /** @type {any} */ ({
    ...backend,
    put: (/** @type {string} */ k, /** @type {any} */ v) => again("a write", () => backend.put(k, v)),
    get: (/** @type {string} */ k) => again("a read", () => backend.get(k)),
    del: (/** @type {string} */ k) => again("a delete", () => backend.del(k)),
    async ping() {
      try { const v = await backend.ping(); lastGood = { at: now(), v }; miss = 0; return v; }
      catch (e) {
        miss++; stats.pingMisses++;
        if (lastGood && miss < maxMiss && now() - lastGood.at < grace) return lastGood.v;
        throw e;
      }
    },
    stats,
  });
}

/**
 * The adapter's `makeBackend` with the bridge wired in. The secret is read from the vault first (the engine's `secret(offer)` is synchronous); a bridged
 * drive with no secret on this device is skipped by the adapter, not half-built. The backend resumes (resilientBackend).
 * `deviceOf(offer)` is the device that serves the drive: the offer's `seenFromDevice`, stored beside the label `seenFrom`.
 * @param {{ backendFor: (c: any, offer: any, o: { bridge: { send: any, secret: (offer: any) => string } }) => any, secrets: ReturnType<typeof createBridgeSecrets>,
 *   linkTo: (device: string) => { call(tool: string, input?: any, opt?: any): Promise<any> }, timeoutMs?: number, retry?: Parameters<typeof resilientBackend>[1] | false,
 *   deviceOf?: (offer: any) => string | undefined }} o
 */
export function bridgeMakeBackend({ backendFor, secrets, linkTo, timeoutMs, retry, deviceOf = (/** @type {any} */ offer) => offer.seenFromDevice || offer.seenFrom }) {
  const send = makeBridgeSend({ linkTo, timeoutMs });
  return async (/** @type {any} */ c, /** @type {any} */ offer) => {
    const secret = await secrets.get(offer.id);
    const device = deviceOf(offer);
    if (!device) throw err("not_found", "That drive does not say which device serves it.");
    const be = await backendFor(c, { ...offer, seenFrom: device }, { bridge: { send, secret: () => { if (!secret) throw err("no_secret", "No secret for that drive on this device."); return secret; } } });
    return retry === false ? be : resilientBackend(be, retry || {});
  };
}

// ---- the secret crosses sealed ----
const SEAL_INFO = "vyre-wink-bridge-seal-v1";
const spki = (/** @type {crypto.KeyObject} */ k) => /** @type {Buffer} */ (k.export({ type: "spki", format: "der" })).toString("base64url");
const unspki = (/** @type {string} */ s) => crypto.createPublicKey({ key: Buffer.from(s, "base64url"), type: "spki", format: "der" });
const sealKey = (/** @type {Buffer} */ shared, /** @type {string} */ offer) => Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(SEAL_INFO), Buffer.from(offer), 32));

/** Seal a secret to the device's one-time public key. @param {string} devicePub @param {string} offer @param {string} secret */
export function sealSecret(devicePub, offer, secret) {
  const eph = crypto.generateKeyPairSync("x25519");
  const key = sealKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: unspki(devicePub) }), offer);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv); c.setAAD(Buffer.from(offer));
  const ct = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return { epk: spki(eph.publicKey), box: Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url") };
}
/** @param {crypto.KeyObject} priv @param {string} offer @param {{ epk: string, box: string }} s */
function openSecret(priv, offer, s) {
  const raw = Buffer.from(String(s.box), "base64url");
  if (raw.length < 12 + 16 + 1 || raw.length > 512) throw err("bad_input", "That sealed secret is not the right size.");
  let key;
  try { key = sealKey(crypto.diffieHellman({ privateKey: priv, publicKey: unspki(String(s.epk)) }), offer); } catch { throw err("bad_input", "That sealed secret is not valid."); }
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); d.setAAD(Buffer.from(offer)); d.setAuthTag(raw.subarray(raw.length - 16));
  try { return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8"); } catch { throw err("denied", "That sealed secret did not open."); }
}

/**
 * Pairing, on the home (it runs where the person approves the card): ask the device that has the drive to open (it answers a one-time public key and checks it
 * can see the drive), make the secret, keep it, and hand it once, sealed to that key. The device keeps it too and starts serving. Undone on both sides if any
 * step fails. `linkTo(device)` is the connection that device holds open to the home. The secret is never a plain input of any call.
 * @param {{ secrets: ReturnType<typeof createBridgeSecrets>, linkTo: (device: string) => { call(tool: string, input?: any, opt?: any): Promise<any> } }} o
 * @param {{ offer: string, device: string, kind: string, location: any, capacity: number }} d
 */
export async function pairFromHome({ secrets, linkTo }, d) {
  const link = linkTo(d.device);
  const shape = { offer: d.offer, kind: d.kind, location: d.location, capacity: d.capacity };
  const lost = (/** @type {any} */ e) => e && (e.code === "unreachable" || e.code === "timeout");
  /** @type {string | null} */ let secret = null;
  /** @type {any} */ let last;
  // The connection can drop between the two steps: the whole hand-over is tried again (a new one-time key, the same secret), up to three times.
  for (let n = 0; n < 3; n++) {
    try {
      const opened = await link.call(ACCEPT_TOOL, { ...shape, step: "open" });
      if (!opened || typeof opened.pub !== "string") throw err("unreachable", "That device did not answer the way a drive's device does.");
      secret ??= await secrets.make(d.offer);
      await link.call(ACCEPT_TOOL, { ...shape, step: "seal", ...sealSecret(opened.pub, d.offer, secret) });
      return;
    } catch (e) { last = e; if (!lost(e)) break; }
  }
  if (secret) await secrets.remove(d.offer);
  throw last;
}

/**
 * Pairing, on the device with the drive: the answer to `wink.storage.bridge.accept`. Accepts a secret only from the home it is paired with, finds the drive
 * mounted on this device, keeps the secret, and starts serving it to that home only. Two steps (see pairFromHome): `open` checks and answers a one-time key
 * (kept in memory for `ttlMs`, used once), `seal` opens the sealed secret with it. A plain `secret` input is refused.
 * `roots` are the folders a drive may be mounted under on this device (the home names a mount, it never gets to name any folder it likes).
 * @param {{ endpoint: ReturnType<typeof createBridgeEndpoint>, secrets: ReturnType<typeof createBridgeSecrets>, home: () => string | null, exists?: (p: string) => boolean, roots?: string[], ttlMs?: number, now?: () => number, hooks?: { afterCheck?: () => void }, onServed?: (r: { offer: string, dir: string, capacity: number, caller: string }) => Promise<void> | void }} o
 */
export function acceptDrive({ endpoint, secrets, home, exists, roots = ["/Volumes", "/mnt", "/media"], ttlMs = 60_000, now = Date.now, hooks, onServed }) {
  /** @type {Map<string, { priv: crypto.KeyObject, until: number }>} */
  const open = new Map();
  return async (/** @type {string} */ caller, /** @type {any} */ input) => {
    const h = home();
    if (!h) throw err("not_found", "This device is not paired to a space's home.");
    if (caller !== `device:${h}`) throw err("denied", "Only the space's home can offer a drive through this device.");
    if (!input || typeof input.offer !== "string" || !ID.test(input.offer)) throw err("bad_input", "That storage id is not valid.");
    if ("secret" in input) throw err("bad_input", "A secret is never sent as it is. Ask to open first, then send it sealed.");
    const loc = input.location || {};
    // Real paths, never lexical ones: a link under a root (or a root that is itself a link, like /Volumes/Macintosh HD) is followed before the check.
    const realRoots = roots.map(r => { try { return realOf(r); } catch { return ""; } }).filter(Boolean);
    const under = (/** @type {string} */ p) => { try { return within(realOf(p), realRoots); } catch { return false; } };
    for (const p of [loc.mount, input.kind === "usb-disk" ? loc.path : undefined]) if (p && (typeof p !== "string" || !under(p))) throw err("denied", "That folder is not one this device shares drives from.");
    const dir = localDriveDir(loc, { kind: input.kind, exists });
    if (!dir || !under(dir)) throw err("not_found", "This device cannot see that drive right now.");
    const cap = Number(input.capacity);
    if (!Number.isFinite(cap) || cap <= 0) throw err("bad_input", "Say how much room may be used.");
    for (const [k, v] of open) if (v.until <= now()) open.delete(k);
    if (input.step === "open") {
      const kp = crypto.generateKeyPairSync("x25519");
      open.set(input.offer, { priv: kp.privateKey, until: now() + ttlMs });
      return { pub: spki(kp.publicKey) };
    }
    if (input.step !== "seal") throw err("bad_input", "Say which step: open or seal.");
    const one = open.get(input.offer); open.delete(input.offer);
    if (!one || one.until <= now()) throw err("denied", "The offer to open has run out. Start the pairing again.");
    const secret = openSecret(one.priv, input.offer, input);
    await secrets.keep(input.offer, secret);
    try {
      const target = path.join(realOf(dir), `vyre-${input.offer}`);
      try { fs.mkdirSync(target, { mode: 0o700 }); } catch { /* it exists already, or the engine makes it; rootedDir looks at what is there */ }
      const rooted = rootedDir({ dir: target, roots, hooks });
      await endpoint.serve({ offer: input.offer, dir: rooted.real, capacity: cap, caller, guard: rooted.check });
      if (onServed) { try { await onServed({ offer: input.offer, dir: rooted.real, capacity: cap, caller }); } catch { /* a record that could not be kept only costs a re-pair after a restart */ } }
    }
    catch (e) { await secrets.remove(input.offer); throw e; }
    return { ok: true };
  };
}

/**
 * What the device with the drive answers when the home calls back on its held connection: `(tool, input)` of a peer session, answered as the home it holds
 * the connection to (the connection is the identity: the device dialled that home and nobody else can call down it).
 * @param {{ endpoint: ReturnType<typeof createBridgeEndpoint>, drive: ReturnType<typeof acceptDrive>, home: () => string | null, scan?: () => Promise<any> }} o
 */
export function bridgeServe({ endpoint, drive, home, scan }) {
  return async (/** @type {string} */ tool, /** @type {any} */ input) => {
    const h = home();
    if (!h) throw err("denied", "This device is not paired to a space's home.");
    const caller = `device:${h}`;
    if (tool === BRIDGE_TOOL) return endpoint.handle(caller, input);
    if (tool === ACCEPT_TOOL) return drive(caller, input);
    if (tool === SCAN_TOOL && scan) return scan();
    throw err("denied", "This connection answers storage calls only.");
  };
}

/**
 * After a restart: serve again each drive this device had accepted (`onServed` kept them). The folder is checked against the roots again, and an offer whose secret or folder is gone is dropped from
 * the list, so a drive that went away is not served by what is left of an old record. Answers the offers served.
 * @param {{ endpoint: ReturnType<typeof createBridgeEndpoint>, kept: { offer: string, dir: string, capacity: number, caller: string }[], roots?: string[], forget: (offer: string) => void, hooks?: { afterCheck?: () => void } }} o
 */
export async function resumeServing({ endpoint, kept, roots = ["/Volumes", "/mnt", "/media"], forget, hooks }) {
  /** @type {string[]} */ const served = [];
  for (const k of kept) {
    try {
      const rooted = rootedDir({ dir: k.dir, roots, hooks });
      await endpoint.serve({ offer: k.offer, dir: rooted.real, capacity: k.capacity, caller: k.caller, guard: rooted.check });
      served.push(k.offer);
    } catch { forget(k.offer); }
  }
  return served;
}
