// @ts-check
// lib/vyre-core-keys: the relay's keys on a Mac, held by vyre-core (ADR 0040 phase 5). Pure, no
// feature state. Three parts:
//   the byte helpers core's key store and the fake share (X25519 DH and Ed25519 signing on raw keys),
//   createCoreKeys: the client core/relay uses, over vyre-core's socket,
//   fakeCoreKeys: the same shape in memory, for tests that must not open a socket.
//
// The shape is async everywhere, dh included: a call to another process cannot be sync. Private
// bytes never cross it: the client sees public halves, a shared secret and a signature.

import crypto from "node:crypto";
import { coreTool, readCoreConfig, socketProblem } from "./vyre-core-client.js";

const X_PRIV = Buffer.from("302e020100300506032b656e04220420", "hex");
const X_PUB = Buffer.from("302a300506032b656e032100", "hex");
const E_PRIV = Buffer.from("302e020100300506032b657004220420", "hex");

/** @param {Buffer} b */ export const b64 = b => b.toString("base64url");
/** @param {any} v @param {string} what @param {number} [len] */
export const raw = (v, what, len = 32) => {
  const b = typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v) ? Buffer.from(v, "base64url") : null;
  if (!b || b.length !== len) throw Object.assign(new Error(`${what} must be ${len} bytes, base64url`), { code: "bad_input" });
  return b;
};
/** @param {Buffer} priv */ export const xPrivateKey = priv => crypto.createPrivateKey({ key: Buffer.concat([X_PRIV, priv]), format: "der", type: "pkcs8" });
/** @param {Buffer} priv */ export const ePrivateKey = priv => crypto.createPrivateKey({ key: Buffer.concat([E_PRIV, priv]), format: "der", type: "pkcs8" });
/** @param {crypto.KeyObject} k */ export const pubRaw = k => Buffer.from((k.type === "private" ? crypto.createPublicKey(k) : k).export({ format: "der", type: "spki" }).subarray(-32));

/** The Noise DH with a raw X25519 private key. Never an all-zero secret (a low-order point). @param {Buffer} priv @param {string} remote base64url */
export function dhB64(priv, remote) {
  const pub = raw(remote, "remote");
  const bad = () => Object.assign(new Error("that public key gives no shared secret"), { code: "bad_input" });
  let out;
  try { out = crypto.diffieHellman({ privateKey: xPrivateKey(priv), publicKey: crypto.createPublicKey({ key: Buffer.concat([X_PUB, pub]), format: "der", type: "spki" }) }); } catch { throw bad(); }
  if (out.every(x => x === 0)) throw bad();
  return b64(Buffer.from(out));
}

/** An Ed25519 signature with a raw private key. @param {Buffer} priv @param {string} message base64url, 1 to 4096 bytes */
export function signB64(priv, message) {
  const m = typeof message === "string" && /^[A-Za-z0-9_-]*$/.test(message) ? Buffer.from(message, "base64url") : null;
  if (!m || !m.length || m.length > 4096) throw Object.assign(new Error("message must be 1 to 4096 bytes, base64url"), { code: "bad_input" });
  return b64(crypto.sign(null, m, ePrivateKey(priv)));
}

/**
 * @typedef {object} CoreKeys
 * @property {() => Promise<boolean>} exists
 * @property {() => Promise<boolean>} ensure  true when it made them
 * @property {() => Promise<Buffer>} boxPub    32 bytes, X25519
 * @property {(remotePub32: Buffer) => Promise<Buffer>} boxDh    32 bytes
 * @property {() => Promise<Buffer>} routePub  32 bytes, Ed25519
 * @property {(message: Buffer) => Promise<Buffer>} routeSign    64 bytes
 */

/**
 * The client over vyre-core's socket. By default it reads core's own root-owned core.json (the same
 * trust rule as vyred's link), and checks before every call that the socket is that uid's, in a
 * folder others can't write: a socket someone else put in core's place would otherwise hand the
 * relay a box key of its own. With no core.json it refuses.
 * @param {{ socket?: string, coreUid?: number, call?: typeof coreTool }} [o] socket, coreUid and call: tests only
 * @returns {CoreKeys}
 */
export function createCoreKeys(o = {}) {
  const call = o.call || coreTool;
  const where = () => {
    if (o.socket !== undefined && typeof o.coreUid === "number") return { socket: o.socket, uid: o.coreUid };
    const c = readCoreConfig();
    if (!c) throw Object.assign(new Error("vyre-core isn't installed here: no trusted core.json"), { code: "core_unavailable" });
    return c;
  };
  /** @param {string} tool @param {any} [input] */
  const ask = async (tool, input = {}) => {
    const { socket, uid } = where();
    const why = call === coreTool ? socketProblem(socket, uid) : null;
    if (why) throw Object.assign(new Error(why), { code: "core_untrusted" });
    const r = await call(tool, input, { socket });
    if (!r.data) throw Object.assign(new Error((r.error && r.error.message) || "vyre-core gave no answer"), { code: (r.error && r.error.code) || "core_unreachable" });
    return r.data;
  };
  /** @type {Buffer | null} */ let box = null;
  /** @type {Buffer | null} */ let route = null;
  const pub = async (/** @type {string} */ tool) => raw((await ask(tool)).pub, `${tool} answer`);
  return {
    exists: async () => Boolean((await ask("keys.exists")).exists),
    ensure: async () => Boolean((await ask("keys.ensure")).created),
    boxPub: async () => (box ||= await pub("keys.box.pub")),
    boxDh: async remote => {
      if (!Buffer.isBuffer(remote) || remote.length !== 32) throw new Error("boxDh takes a 32-byte public key");
      return raw((await ask("keys.box.dh", { remote: b64(remote) })).secret, "keys.box.dh answer");
    },
    routePub: async () => (route ||= await pub("keys.route.pub")),
    routeSign: async message => {
      if (!Buffer.isBuffer(message) || !message.length) throw new Error("routeSign takes the bytes to sign");
      return raw((await ask("keys.route.sign", { message: b64(message) })).sig, "keys.route.sign answer", 64);
    },
  };
}

/**
 * The same shape in memory, for tests that must not open a socket. Keys come from the seed, so a
 * test's box has the same identity on every run.
 * @param {string} [seed]
 * @returns {CoreKeys & { created: boolean }}
 */
export function fakeCoreKeys(seed = "fake") {
  const h = (/** @type {string} */ n) => crypto.createHash("sha256").update(`${seed}:${n}`).digest();
  const boxPriv = h("box"), routePriv = h("route");
  let made = false;
  const self = {
    get created() { return made; },
    exists: async () => made,
    ensure: async () => { const was = made; made = true; return !was; },
    boxPub: async () => pubRaw(xPrivateKey(boxPriv)),
    boxDh: async (/** @type {Buffer} */ remote) => raw(dhB64(boxPriv, b64(remote)), "dh"),
    routePub: async () => pubRaw(ePrivateKey(routePriv)),
    routeSign: async (/** @type {Buffer} */ message) => raw(signB64(routePriv, b64(message)), "sig", 64),
  };
  return self;
}
