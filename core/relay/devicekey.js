// @ts-check
// This machine's identity as a device of another box (relay.join, the desktop's tailnet join): the
// key the relay client (relay/client) runs Noise as the initiator with. Its two homes:
//   a file, relay-device/key.json (0600), on a machine where that file is the best there is;
//   vyre-core (lib/vyre-core-keys.js deviceExists/deviceEnsure/devicePub/deviceDh), where the
//   private bytes never leave core. The client already treats the private key as an opaque handle
//   and only ever asks a crypto provider to dh with it, so the core home is a keyStore whose
//   privateKey is a marker and a provider whose dh asks core.

import path from "node:path";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";

const CORE = Object.freeze({ heldBy: "vyre-core" });

/**
 * @param {{ deviceEnsure(): Promise<boolean>, devicePub(): Promise<Buffer>, deviceDh(remote: Buffer): Promise<Buffer> }} core
 */
export function coreDeviceKey(core) {
  const base = nodeCrypto();
  return {
    crypto: /** @type {import("../../relay/client/noise.js").CryptoProvider} */ ({
      ...base,
      dh: async (priv, pub) => (priv === CORE ? new Uint8Array(await core.deviceDh(Buffer.from(pub))) : base.dh(priv, pub)),
    }),
    /** @type {import("../../relay/client/webcrypto.js").KeyStore} */
    keyStore: {
      async get() { await core.deviceEnsure(); return { privateKey: CORE, publicKey: new Uint8Array(await core.devicePub()) }; },
      async set() { /* core made it; there is nothing to keep here */ },
    },
  };
}

/** The device key for this machine: vyre-core's when it holds keys, else the file under `root`. @param {string} root @param {any} [core] */
export function deviceKeyFor(root, core) {
  return core ? coreDeviceKey(core) : { crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(root, "relay-device", "key.json")) };
}
