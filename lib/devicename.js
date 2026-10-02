// @ts-check
// devicename: a device's name as a person reads it. A device names itself with what its system knows, which is often
// "mac.local", "localhost" or a hostname with dashes. The box keeps a friendly label instead, and the person can change it
// (relay.devices.rename, link.rename). This only cleans what a device offers at pairing; it never touches a name the person
// chose later.

const SUFFIX = /\.(local|lan|home|localdomain|internal|fritz\.box)$/i;
const EMPTY = /^(localhost(\..*)?|unknown|device|computer|mac|iphone|ipad|android|phone|\d{1,3}(\.\d{1,3}){3})$/i;
const DEVICE_WORD = /(macbook|imac|mac-?mini|mac-?studio|iphone|ipad|laptop|desktop|\bpc\b|surface|thinkpad)/i;

// Invisible and direction-changing characters a device could put in its own name to make it look like another's: zero-width,
// bidi controls and isolates, the soft hyphen, the byte-order mark, the astral tag characters (U+E0000 to U+E007F) and the other
// format characters. The zero-width joiner and variation selector 16 stay only inside an emoji sequence, where they are what
// makes a family or a coloured heart one emoji.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const KEEP_VS16 = "\ue000", KEEP_ZWJ = "\ue001";

/** A label as typed or offered: control characters become spaces, invisible and bidi characters go (emoji joiners stay), spaces collapse. @param {unknown} raw */
export function cleanLabel(raw) {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ue000\ue001]/g, " ")
    .replace(/(\p{Extended_Pictographic})\ufe0f/gu, `$1${KEEP_VS16}`)
    .replace(/(\p{Extended_Pictographic}\ue000?)\u200d(?=\p{Extended_Pictographic})/gu, `$1${KEEP_ZWJ}`)
    .replace(INVISIBLE, "");
  return s.replace(/\ue000/g, "\ufe0f").replace(/\ue001/g, "\u200d").replace(/\s+/g, " ").trim();
}

/** @param {string} owner the person's name as typed, or "" */
const first = owner => String(owner || "").trim().split(/\s+/)[0] || "";

/**
 * @param {unknown} raw what the device called itself
 * @param {{ kind?: "mac"|"device"|"web"|"app"|"phone"|"pc", owner?: string }} [o]
 * @returns {string} 1 to 64 printable characters, never ".local" or "localhost"
 */
export function friendlyDeviceName(raw, o = {}) {
  let n = cleanLabel(raw).replace(SUFFIX, "").trim();
  // A dashed hostname that names a kind of device reads better with spaces: "Alexs-MacBook-Pro" -> "Alexs MacBook Pro".
  if (/^[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/.test(n) && DEVICE_WORD.test(n)) n = n.replace(/-/g, " ");
  if (n && !EMPTY.test(n)) return n.slice(0, 64);
  const thing = o.kind === "mac" ? "Mac" : o.kind === "web" ? "browser" : o.kind === "phone" ? "phone" : o.kind === "pc" ? "PC" : "device";
  const who = first(o.owner || "");
  return who ? `${who}'s ${thing}`.slice(0, 64) : `${thing[0].toUpperCase()}${thing.slice(1)}`;
}
