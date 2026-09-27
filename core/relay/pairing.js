// @ts-check
// pairing: the QR code's payload (ADR 0026, section 6). It lives in a URL fragment, which a
// browser never sends to a server, so vyre.run never sees the box key or the secret.

export const PAIR_BASE = "https://vyre.run/pair";

/**
 * @param {{ relay: string, route: string, box: Buffer, secret: string, name: string }} o
 */
export function pairUrl(o) {
  const offer = { v: 1, r: o.relay, i: o.route, k: o.box.toString("base64url"), s: o.secret, n: o.name };
  return `${PAIR_BASE}#${Buffer.from(JSON.stringify(offer)).toString("base64url")}`;
}

/**
 * The offer in a scanned URL, or null when it is not one of ours.
 * @param {string} url
 * @returns {{ relay: string, route: string, box: Buffer, secret: string, name: string } | null}
 */
export function parsePairUrl(url) {
  const at = String(url).indexOf("#");
  if (at < 0 || !String(url).startsWith(PAIR_BASE)) return null;
  let o;
  try { o = JSON.parse(Buffer.from(String(url).slice(at + 1), "base64url").toString()); } catch { return null; }
  if (!o || o.v !== 1 || typeof o.r !== "string" || !/^[a-z2-7]{26}$/.test(o.i) || typeof o.s !== "string" || typeof o.k !== "string") return null;
  const box = Buffer.from(o.k, "base64url");
  if (box.length !== 32 || !/^wss?:\/\/[^\s/]+/.test(o.r)) return null;
  return { relay: o.r, route: o.i, box, secret: o.s, name: typeof o.n === "string" ? o.n.slice(0, 64) : "" };
}
