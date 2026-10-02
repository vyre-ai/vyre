// @ts-check
// devicename: a device's name as a person reads it. A device names itself with what its system knows, which is often
// "mac.local", "localhost" or a hostname with dashes. The box keeps a friendly label instead, and the person can change it
// (relay.devices.rename, link.rename). This only cleans what a device offers at pairing; it never touches a name the person
// chose later.

const SUFFIX = /\.(local|lan|home|localdomain|internal|fritz\.box)$/i;
const EMPTY = /^(localhost(\..*)?|unknown|device|computer|mac|iphone|ipad|android|phone|\d{1,3}(\.\d{1,3}){3})$/i;
const DEVICE_WORD = /(macbook|imac|mac-?mini|mac-?studio|iphone|ipad|laptop|desktop|\bpc\b|surface|thinkpad)/i;

/** @param {string} owner the person's name as typed, or "" */
const first = owner => String(owner || "").trim().split(/\s+/)[0] || "";

/**
 * @param {unknown} raw what the device called itself
 * @param {{ kind?: "mac"|"device"|"web"|"app"|"phone"|"pc", owner?: string }} [o]
 * @returns {string} 1 to 64 printable characters, never ".local" or "localhost"
 */
export function friendlyDeviceName(raw, o = {}) {
  let n = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(SUFFIX, "").trim();
  // A dashed hostname that names a kind of device reads better with spaces: "Alexs-MacBook-Pro" -> "Alexs MacBook Pro".
  if (/^[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/.test(n) && DEVICE_WORD.test(n)) n = n.replace(/-/g, " ");
  if (n && !EMPTY.test(n)) return n.slice(0, 64);
  const thing = o.kind === "mac" ? "Mac" : o.kind === "web" ? "browser" : o.kind === "phone" ? "phone" : o.kind === "pc" ? "PC" : "device";
  const who = first(o.owner || "");
  return who ? `${who}'s ${thing}`.slice(0, 64) : `${thing[0].toUpperCase()}${thing.slice(1)}`;
}
