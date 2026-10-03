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
// event, not in a log line, not in a card. It crosses once, inside the Wink call that hands it over (home to device), which is encrypted end to end on both paths.
// Chunks are ciphertext before they reach this code, so the frames carry nothing readable either way.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BRIDGE_TOOL = "wink.storage.bridge";
export const DRIVE_TOOL = "wink.storage.bridge.drive";
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
  /** @type {Map<string, { caller: string, bridge: { handle(f: any): Promise<{ status: number, body?: Buffer }> } }>} */
  const serving = new Map();
  return {
    /** Start serving an offer from a folder on this device, for one caller. @param {{ offer: string, dir: string, capacity: number, caller: string }} o */
    async serve({ offer, dir, capacity, caller }) {
      const secret = await secrets.get(offer);
      if (!secret) throw err("no_secret", "This device has no secret for that drive, so it cannot serve it.");
      if (!/^device:[A-Za-z0-9_-]{1,64}$/.test(caller)) throw err("bad_input", "Name the device that may ask, like device:dev_abc.");
      serving.set(offer, { caller, bridge: createBridge({ dir, secret, capacity }) });
    },
    /** @param {string} offer */
    stop(offer) { serving.delete(offer); },
    has: (/** @type {string} */ offer) => serving.has(offer),
    /**
     * The Wink call. `caller` is the identity the connection proved, never anything in `input`.
     * @param {string} caller @param {{ offer: string, op: string, key?: string, ts: number, sig: string, body?: string }} input
     * @returns {Promise<{ status: number, body?: string }>}
     */
    async handle(caller, input) {
      const s = input && typeof input.offer === "string" ? serving.get(input.offer) : undefined;
      if (!s) throw err("not_found", "This device is not serving that drive.");
      if (s.caller !== caller) { log("wink storage: a bridge call from a device that does not own the drive was refused"); throw err("denied", "Only the device the drive was offered to may use it."); }
      if (!(await live(input.offer))) throw err("denied", "That drive is no longer offered.");
      if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > Math.ceil(MAX_FRAME_BODY * 4 / 3) + 4)) return { status: 413 };
      const body = input.body ? Buffer.from(input.body, "base64") : undefined;
      const r = await s.bridge.handle({ op: input.op, key: input.key, ts: input.ts, sig: input.sig, ...(body ? { body } : {}) });
      return { status: r.status, ...(r.body ? { body: r.body.toString("base64") } : {}) };
    },
  };
}

/**
 * Home side: `bridge.send(deviceId, offer)` of devices.js. `linkTo(deviceId)` returns the Wink channel to that device ({ call(tool, input, opt) }): the node
 * host's `connect(space).call` in the product.
 * @param {{ linkTo: (device: string) => { call(tool: string, input?: any, opt?: { timeoutMs?: number }): Promise<any> }, timeoutMs?: number }} o
 */
export function makeBridgeSend({ linkTo, timeoutMs = 60_000 }) {
  return (/** @type {string} */ device, /** @type {{ id: string }} */ offer) => async (/** @type {{ op: string, key?: string, body?: Buffer, ts: number, sig: string }} */ f) => {
    if (f.body && f.body.length > MAX_FRAME_BODY) return { status: 413 };
    const r = await linkTo(device).call(BRIDGE_TOOL, { offer: offer.id, op: f.op, key: f.key, ts: f.ts, sig: f.sig, ...(f.body ? { body: Buffer.from(f.body).toString("base64") } : {}) }, { timeoutMs });
    return { status: Number(r.status), ...(r.body ? { body: Buffer.from(r.body, "base64") } : {}) };
  };
}

/**
 * The adapter's `makeBackend` with the bridge wired in. The secret is read from the vault first (the engine's `secret(offer)` is synchronous); a bridged
 * drive with no secret on this device is skipped by the adapter, not half-built.
 * @param {{ backendFor: (c: any, offer: any, o: { bridge: { send: any, secret: (offer: any) => string } }) => any, secrets: ReturnType<typeof createBridgeSecrets>,
 *   linkTo: (device: string) => { call(tool: string, input?: any, opt?: any): Promise<any> }, timeoutMs?: number }} o
 */
export function bridgeMakeBackend({ backendFor, secrets, linkTo, timeoutMs }) {
  const send = makeBridgeSend({ linkTo, timeoutMs });
  return async (/** @type {any} */ c, /** @type {any} */ offer) => {
    const secret = await secrets.get(offer.id);
    return backendFor(c, offer, { bridge: { send, secret: () => { if (!secret) throw err("no_secret", "No secret for that drive on this device."); return secret; } } });
  };
}

/**
 * Pairing, on the home (it runs where the person approves the card): make the secret, keep it, and hand it once to the device that has the drive, which keeps
 * it too and starts serving. Undone on both sides if any step fails. `ask` is the Wink call to that device ({ call }).
 * @param {{ secrets: ReturnType<typeof createBridgeSecrets>, linkTo: (device: string) => { call(tool: string, input?: any, opt?: any): Promise<any> } }} o
 * @param {{ offer: string, device: string, kind: string, location: any, capacity: number }} d
 */
export async function pairFromHome({ secrets, linkTo }, d) {
  const secret = await secrets.make(d.offer);
  try {
    await linkTo(d.device).call(DRIVE_TOOL, { offer: d.offer, secret, kind: d.kind, location: d.location, capacity: d.capacity });
  } catch (e) { await secrets.remove(d.offer); throw e; }
}

/**
 * Pairing, on the device with the drive: the answer to `wink.storage.bridge.drive`. Accepts a secret only from the home it is paired with, finds the drive
 * mounted on this device, keeps the secret, and starts serving it to that home only.
 * @param {{ endpoint: ReturnType<typeof createBridgeEndpoint>, secrets: ReturnType<typeof createBridgeSecrets>, home: () => string | null, exists?: (p: string) => boolean, roots?: string[] }} o
 * `roots` are the folders a drive may be mounted under on this device (the home names a mount, it never gets to name any folder it likes).
 */
export function acceptDrive({ endpoint, secrets, home, exists, roots = ["/Volumes", "/mnt", "/media"] }) {
  return async (/** @type {string} */ caller, /** @type {{ offer: string, secret: string, kind?: string, location?: any, capacity: number }} */ input) => {
    const h = home();
    if (!h) throw err("not_found", "This device is not paired to a space's home.");
    if (caller !== `device:${h}`) throw err("denied", "Only the space's home can offer a drive through this device.");
    const loc = input.location || {};
    const under = (/** @type {string} */ p) => roots.some(r => { const x = path.resolve(p), b = path.resolve(r); return x === b || x.startsWith(b + path.sep); });
    for (const p of [loc.mount, input.kind === "usb-disk" ? loc.path : undefined]) if (p && (typeof p !== "string" || !under(p))) throw err("denied", "That folder is not one this device shares drives from.");
    const dir = localDriveDir(loc, { kind: input.kind, exists });
    if (!dir || !under(dir)) throw err("not_found", "This device cannot see that drive right now.");
    const cap = Number(input.capacity);
    if (!Number.isFinite(cap) || cap <= 0) throw err("bad_input", "Say how much room may be used.");
    await secrets.keep(input.offer, input.secret);
    try { await endpoint.serve({ offer: input.offer, dir: `${dir.replace(/\/+$/, "")}/vyre-${input.offer}`, capacity: cap, caller }); }
    catch (e) { await secrets.remove(input.offer); throw e; }
    return { ok: true };
  };
}
