// @ts-check
// shellkey: the device key of a desktop shell whose private half stays in the shell's native side
// (the Windows app keeps it under DPAPI, in Rust), for a bundled local page that runs this client
// and so holds the box's Noise channel. The client already treats a device's private key as an
// opaque handle and only asks its crypto provider to `dh` with it, so the page never sees key
// bytes: the keyStore's private key is a marker, and `dh` is a call into the shell.
//
// The shell's two commands, named here so both sides build to one contract (Tauri: `invoke`):
//   device_key_pub()                 -> base64url, the 32-byte X25519 public key; made on first use
//   device_key_dh({ remote })        -> base64url, the 32-byte shared secret with that public key
// Neither ever returns the private key. Only the bundled local pages may call them.

import { base64url, fromBase64url } from "./bytes.js";
import { webCrypto } from "./webcrypto.js";

const MARKER = Object.freeze({ heldBy: "the shell" });

/**
 * @param {(cmd: string, args?: any) => Promise<any>} invoke the shell's IPC (Tauri's invoke)
 * @param {{ crypto?: import("./noise.js").CryptoProvider }} [o] the provider for everything but the static key's dh
 */
export function shellDeviceKey(invoke, o = {}) {
  const base = o.crypto || webCrypto();
  return {
    /** @type {import("./noise.js").CryptoProvider} */
    crypto: {
      ...base,
      async dh(priv, pub) {
        if (priv !== MARKER) return base.dh(priv, pub);
        const out = fromBase64url(String(await invoke("device_key_dh", { remote: base64url(pub) })));
        if (out.length !== 32) throw new Error("the shell gave no shared secret");
        return out;
      },
    },
    /** @type {import("./webcrypto.js").KeyStore} */
    keyStore: {
      async get() {
        const pub = fromBase64url(String(await invoke("device_key_pub")));
        if (pub.length !== 32) throw new Error("the shell gave no device key");
        return { privateKey: MARKER, publicKey: pub };
      },
      async set() { /* the shell made it and keeps it */ },
    },
  };
}
