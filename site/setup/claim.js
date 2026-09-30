// @ts-check
// claim: the page's half of the claim token (tailnet's B4). The box makes a challenge; the page signs it, with the key that
// made the setup code, over the box's own route and the exact address it is being claimed at, so a token for another box or
// another name never verifies. The result goes only in a link's fragment, which is never sent to a server or logged.

const enc = new TextEncoder();
const utf8 = s => enc.encode(s);
const concat = (...p) => { const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of p) { out.set(x, at); at += x.length; } return out; };
const base64url = b => { let bin = ""; for (const x of b) bin += String.fromCharCode(x); return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const fromBase64url = s => { if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url"); const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };

/**
 * token = base64url(challenge || signature), the signature ECDSA P-256 (r || s) by the page key over
 * "vyre-setup-claim\n" || route || "\n" || challenge || "\n" || <name>.vyre.run.
 * @param {{ privateKey: CryptoKey, route: string, challenge: string, host: string, subtle?: SubtleCrypto }} o
 * @returns {Promise<string>}
 */
export async function signClaim(o) {
  const subtle = o.subtle || globalThis.crypto.subtle;
  const challenge = fromBase64url(o.challenge);
  if (challenge.length !== 32) throw new Error("the box's challenge is not 32 bytes");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.vyre\.run$/.test(o.host)) throw new Error("not a vyre.run address");
  const msg = concat(utf8(`vyre-setup-claim\n${o.route}\n`), challenge, utf8(`\n${o.host}`));
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.privateKey, msg));
  return base64url(concat(challenge, sig));
}
