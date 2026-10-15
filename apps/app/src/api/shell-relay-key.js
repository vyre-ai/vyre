// @ts-check
// The Mac app's relay device key, seen from its page: the shell keeps the X25519 key in the Mac's Keychain (local/capsule/native/Sources/Host/MacRelayKey.swift) and does the Diffie-Hellman itself,
// so the key never reaches the page. The WKWebView gave a CryptoKey stored in IndexedDB back as nothing, so the page made a new key on every dial and its servers stopped knowing it (0.5.2).
// The key store hands relay/client a stand-in for the private key; the crypto provider sends any DH with that stand-in to the shell and every other DH (the handshake's own one-time keys) to WebCrypto.
// There is no fallback to IndexedDB here: a shell that cannot keep the key says so, and the dial fails with its words.

/** The private half the relay client carries around: only a name for the shell's key, never the key. */
export const SHELL_RELAY_KEY = Object.freeze({ held: "mac-shell" });

const b64u = (/** @type {Uint8Array} */ b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (/** @type {string} */ s) => { const t = atob(String(s).replace(/-/g, "+").replace(/_/g, "/")); const out = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i); return out; };

/**
 * @typedef {{ public(create?: boolean): Promise<string>, dh(peer: string): Promise<string>, forget?(): Promise<void> }} ShellRelayBridge the shell's calls (window.__vyreShell.relayKey), base64url both ways;
 *   `forget` drops the key (a removed device's wipe), and the next pairing makes a new one
 */

/** The shell's relay key calls, when this page runs in a Mac shell that has them (an older shell has not: the page then keeps the key as a browser does). @param {any} w @returns {ShellRelayBridge | null} */
export function shellRelayBridge(w = typeof window === "undefined" ? undefined : window) {
  const s = w && w.__vyreShell;
  const k = s && s.kind === "mac" && s.relayKey;
  return k && typeof k.public === "function" && typeof k.dh === "function" ? k : null;
}

/** The key store over the shell: the key is made there on first use and is the same after a restart. `set` is never needed (get always answers) and refuses. @param {ShellRelayBridge} bridge */
export function shellRelayKeyStore(bridge) {
  return {
    async get() {
      const pub = unb64u(await bridge.public(true));
      if (pub.length !== 32) throw new Error("This Mac gave a relay key of the wrong size.");
      return { privateKey: SHELL_RELAY_KEY, publicKey: pub };
    },
    async set() { throw new Error("This Mac keeps its own relay key; the page cannot replace it."); },
  };
}

/** The crypto provider over the shell: `base` (WebCrypto) for everything, except a DH with the shell's key, which the shell does. @param {ShellRelayBridge} bridge @param {any} base */
export function shellRelayCrypto(bridge, base) {
  return {
    ...base,
    /** @param {any} privateKey @param {Uint8Array} peerPub */
    async dh(privateKey, peerPub) {
      if (privateKey !== SHELL_RELAY_KEY) return base.dh(privateKey, peerPub);
      const out = unb64u(await bridge.dh(b64u(peerPub)));
      if (out.length !== 32) throw new Error("This Mac gave a shared secret of the wrong size.");
      return out;
    },
  };
}
