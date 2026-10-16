// @ts-check
// The pure parts of Continue with GitHub, runnable in Node: the link message the device signs, the account message, the home hint, and opening what the escrow sealed to this device.
// Browser-free and box-free; real-github.ts holds the calls.

export const GH_TAG_LINK = "vyre-gh-link-v1";
export const GH_TAG_ACCOUNT = "vyre-gh-account-v1";
const enc = new TextEncoder();
const unb64u = (/** @type {string} */ s) => { const t = s.replace(/-/g, "+").replace(/_/g, "/"); return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };
const b64u = (/** @type {Uint8Array} */ b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The bytes a device signs to link: they name the GitHub id, the identity, this ticket, the time and the relay's host, so the request cannot be moved to another ticket, host or moment. */
export const linkMessage = (/** @type {{ ghid: number, identity: string, tid: string, ts: number, host: string }} */ m) => enc.encode(`${GH_TAG_LINK}\n${m.ghid}\n${m.identity}\n${m.tid}\n${m.ts}\n${m.host}`);
export const accountMessage = (/** @type {{ action: string, identity: string, nonce: string, ts: number, host: string }} */ m) => enc.encode(`${GH_TAG_ACCOUNT}\n${m.action}\n${m.identity}\n${m.nonce}\n${m.ts}\n${m.host}`);
export const ticketId = async (/** @type {string} */ ticket) => b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(ticket))));
/** The verifier the app keeps and the challenge the relay is given. */
export async function newVerifier() {
  const cv = b64u(crypto.getRandomValues(new Uint8Array(32)));
  return { cv, cc: await ticketId(cv) };
}

/** The home hint a device hands the escrow: the one route and pinned box key of the server that holds the vault. null when there is no pairing to point at. */
export function homeHintText(/** @type {{ relay?: string, route?: string, box?: string, name?: string } | null | undefined} */ p) {
  if (!p || typeof p.relay !== "string" || !/^wss:\/\//.test(p.relay) || typeof p.route !== "string" || !p.route || typeof p.box !== "string" || p.box.length < 32) return null;
  const name = typeof p.name === "string" ? p.name.trim().slice(0, 64) : "";
  const text = JSON.stringify({ v: 1, relay: p.relay, route: p.route, box: p.box, ...(name ? { name } : {}) });
  return text.length <= 512 ? text : null;
}
/** The hint back as a pairing, refusing anything that is not a pinned wss route. */
export function parseHomeHint(/** @type {unknown} */ text) {
  let j; try { j = JSON.parse(String(text ?? "")); } catch { return null; }
  if (!j || j.v !== 1 || typeof j.relay !== "string" || !/^wss:\/\//.test(j.relay) || typeof j.route !== "string" || !j.route || typeof j.box !== "string" || j.box.length < 32) return null;
  return { relay: j.relay, route: j.route, box: j.box, name: typeof j.name === "string" ? j.name : "" };
}

/**
 * Open what the escrow sealed to this device's agreement point: HKDF-SHA256 (empty salt) over the ECDH secret, then AES-GCM. `agree(epk)` is this device's own ECDH (agree.ts), so the private key never
 * reaches this file. Gives {sk, home} or throws code "bad_bundle".
 * @param {{ eph: string, iv: string, ct: string }} sealed @param {(epk: string) => Promise<Uint8Array>} agree
 */
export async function openRelease(sealed, agree) {
  try {
    const secret = await agree(sealed.eph);
    const hk = await crypto.subtle.importKey("raw", /** @type {BufferSource} */ (secret), "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("vyre-gh-escrow-release-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: /** @type {BufferSource} */ (unb64u(sealed.iv)) }, key, /** @type {BufferSource} */ (unb64u(sealed.ct))));
    const j = JSON.parse(new TextDecoder().decode(plain));
    if (!j || j.v !== 1 || typeof j.sk !== "string") throw new Error("shape");
    return { sk: /** @type {string} */ (j.sk), home: /** @type {string|null} */ (j.home ?? null) };
  } catch { throw Object.assign(new Error("What GitHub sign-in released could not be opened on this device."), { code: "bad_bundle" }); }
}

/** The sentences for each way a GitHub step ends. */
export function githubSay(/** @type {string|undefined} */ code) {
  if (code === "popup") return "The GitHub window was blocked. Allow pop-ups for this page, then try again.";
  if (code === "denied") return "GitHub sign-in was cancelled. Nothing was changed.";
  if (code === "timeout") return "GitHub did not answer in time. Try again.";
  if (code === "expired") return "That GitHub sign-in has run out. Start again.";
  if (code === "not_linked") return "This GitHub account is not linked to a Vyre name yet. Sign in with your name, then link GitHub in Settings.";
  if (code === "no_agree_key") return "This device cannot make the key it needs. Use your name and another device instead.";
  if (code === "bad_bundle") return "What GitHub sign-in released could not be opened on this device. Use your name and another device instead.";
  if (code === "no_vault_tool") return "Your vault cannot take the key from GitHub sign-in in this build yet. Use your name and another device instead.";
  if (code === "unreachable") return "Vyre cannot reach GitHub sign-in right now. Try again in a minute.";
  return "GitHub sign-in did not work. Nothing was changed.";
}
