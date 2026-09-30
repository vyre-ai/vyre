// @ts-check
// The box's relay keys: box.key (Noise static, the QR carries its public half) and route.key
// (proves the route to the relay). One small interface so moving where these live, into
// vyre-core's `_vyre` service user (ADR 0040), off the person's own uid, is a swap of this file,
// not a rewrite of core/relay/index.js's pairing logic, which only ever calls loadKeys(root).
//
// Today: ~/.vyre/relay/keys.json (0600), made on first use, never leaves the box. That file sits
// on the person's own uid, so a process running as them (including a prompt-injected model) can
// read or replace it, the reason relay-on-a-Mac is not enabled by default until vyre-core holds
// this instead (docs/work/tailnet.md "Needs from others").

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { keyPair, dh } from "./noise.js";
import { newRouteKey, signRoute } from "./wire.js";

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
 * The handle the relay module works through: it never sees private bytes, only the two public keys
 * and the two operations that need the private ones (a Diffie-Hellman for the box's Noise key, a
 * signature for the route key). Both operations are async, because when vyre-core holds the keys
 * they are a call to a root daemon. Public keys are read once and cached, so after `await ready()`
 * `box.pub` and `route.pub` are plain synchronous values; before it they throw.
 *
 * With `core` (lib/vyre-core-keys.js's createCoreKeys, or its fake in a test) the private bytes
 * stay in vyre-core. Without it they are the 0600 file above, on the person's own uid, which is why
 * a Mac has no relay until core exists (macCoreRefusal in ./index.js).
 * @param {{ root: string, core?: { exists(): Promise<boolean>, ensure(): Promise<boolean>, boxPub(): Promise<Buffer>, boxDh(remote: Buffer): Promise<Buffer>, routePub(): Promise<Buffer>, routeSign(msg: Buffer): Promise<Buffer> } | null }} o
 */
export function keyHandle(o) {
  const core = o.core || null;
  /** @type {{ box: Buffer, route: Buffer } | null} */
  let pubs = null;
  /** @type {ReturnType<typeof loadKeys> | null} */
  let local = null;
  /** @type {Promise<void> | null} */
  let loading = null;
  const need = () => { if (!pubs) throw new Error("the relay keys are not loaded yet"); return pubs; };
  return {
    /** Whether this handle's keys are held by vyre-core. */
    core: Boolean(core),
    /** vyre-core's key store itself, for the one other key it holds here: this machine's device key (./devicekey.js). */
    client: core,
    /** Whether the public keys are read (and so the keys exist). */
    get loaded() { return Boolean(pubs); },
    /** Whether keys exist yet, without making them. */
    async exists() {
      if (pubs) return true;
      if (core) return Boolean(await core.exists());
      return fs.existsSync(path.join(o.root, "relay", "keys.json"));
    },
    /** Read the public keys, making the keys first when there are none. */
    ready() {
      if (pubs) return Promise.resolve();
      return loading = loading || (async () => {
        if (core) {
          await core.ensure();
          pubs = { box: Buffer.from(await core.boxPub()), route: Buffer.from(await core.routePub()) };
        } else {
          local = loadKeys(o.root);
          pubs = { box: local.box.pub, route: Buffer.from(local.route.pub) };
        }
      })().finally(() => { loading = null; });
    },
    /** The box's Noise static key, in the shape Handshake takes. */
    box: {
      get pub() { return need().box; },
      /** @param {Buffer} remote */
      dh: async remote => (core ? Buffer.from(await core.boxDh(remote)) : dh(/** @type {any} */ (local).box.priv, remote)),
    },
    /** The route key. */
    route: {
      get pub() { return need().route; },
      /** @param {Buffer} msg */
      sign: async msg => (core ? Buffer.from(await core.routeSign(msg)) : signRoute(/** @type {any} */ (local).route.priv, msg)),
    },
  };
}
