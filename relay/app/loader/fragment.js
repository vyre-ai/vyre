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

/**
 * The words on the confirm card for a resolved ticket, as plain text only (the loader writes them with textContent, never
 * as markup). `says` is what the box CLAIMS to be; the fingerprint is the part that is checkable.
 * @param {{ name: string, handle: string | null, fingerprint: string }} r
 * @returns {{ says: string, fingerprint: string }}
 */
export function cardWords(r) {
  const says = r.handle ? `${r.handle}.vyre.run` : String(r.name || "a Vyre box");
  return { says: says.slice(0, 80), fingerprint: String(r.fingerprint || "").slice(0, 20) };
}

/**
 * A ticket to a paired box: ONE lookup, the card, and the pairing from the record that lookup returned. A lookup uses the ticket up
 * at the relay, so nothing here looks it up twice; the pairing takes the held record. Nothing is paired unless the person taps Pair.
 * @template F @template B
 * @param {Uint8Array} ticket
 * @param {{ resolve: (ticket: Uint8Array) => Promise<F>, confirm: (found: F) => Promise<boolean>, pair: (found: F) => Promise<B> }} d
 * @returns {Promise<B | null>} the box record, or null when the person chose Not now
 */
export async function pairWithCard(ticket, d) {
  const found = await d.resolve(ticket);
  if (!(await d.confirm(found))) return null;
  return d.pair(found);
}
