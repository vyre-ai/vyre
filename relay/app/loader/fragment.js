// @ts-check
// fragment: what the hosted app reads from its own address when the camera page (wink.vyre.run) hands a pairing over:
// `https://app.vyre.run/#pair=<ticket>`, the single-use ticket as base64url (8 to 32 bytes). Pure, so it is tested in Node.

/** The relay a hosted-app pairing ticket was registered with (the box's own relay is in the record; this is where to ask). */
export const HOSTED_RELAY = "wss://relay.vyre.run";

/**
 * The ticket bytes in a `#pair=` fragment, or null when the fragment is anything else.
 * @param {string} hash location.hash, including the leading "#"
 * @returns {Uint8Array | null}
 */
export function pairTicketFrom(hash) {
  const m = /^#pair=([A-Za-z0-9_-]{11,43})$/.exec(String(hash || ""));
  if (!m) return null;
  try {
    const b = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b + "===".slice((b.length + 3) % 4));
    const raw = Uint8Array.from(bin, c => c.charCodeAt(0));
    return raw.length >= 8 && raw.length <= 32 ? raw : null;
  } catch { return null; }
}
