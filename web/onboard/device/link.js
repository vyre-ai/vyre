// @ts-check
// The pure parts of /onboard/device (ADR 0018 section 3), kept apart from the page so node can
// test them: what the phone app put in the link, the one presence.enroll input a proof is bound
// to, and the only way back, vyre://enrolled.

/** The app's own scheme. Nothing else is a way back: a link must not send a key id anywhere else. */
export const SCHEME = "vyre";

// base64url SPKI DER. A P-256 key is 91 bytes, 122 characters; the bounds only keep out garbage.
const KEY = /^[A-Za-z0-9_-]{60,512}$/;

/** Control characters and bidi overrides go: the name is shown on this page and in Settings. */
const clean = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, " ").replace(/ {2,}/g, " ").trim();

/**
 * Read `#k=<base64url SPKI>&n=<device name>&r=vyre`.
 * @param {string} hash location.hash, with or without its "#"
 * @returns {{ ok: true, publicKey: string, name: string } | { ok: false, reason: "return" | "key" }}
 */
export function parseLink(hash) {
  const q = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  if (q.get("r") !== SCHEME) return { ok: false, reason: "return" };
  const publicKey = q.get("k") || "";
  if (!KEY.test(publicKey)) return { ok: false, reason: "key" };
  const name = clean(q.get("n") || "").slice(0, 80).trim() || "This phone";
  return { ok: true, publicKey, name };
}

/**
 * The presence.enroll input, exactly: the passkey challenge is bound to its hash, and the call
 * must carry the same object.
 * @param {{ publicKey: string, name: string }} link
 */
export const enrollInput = ({ publicKey, name }) => ({ kind: "device", name, public_key: publicKey, alg: -7 });

/**
 * Where the page sends the person back: `vyre://enrolled?id=<key id>` or `?error=<why>`.
 * @param {{ id?: string, error?: string }} params
 */
export const returnUrl = params => `${SCHEME}://enrolled?${new URLSearchParams(/** @type {Record<string, string>} */ (params))}`;
