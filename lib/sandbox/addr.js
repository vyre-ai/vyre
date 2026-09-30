// @ts-check
// addr: is this IP address one a sandboxed child may be sent to? Only public addresses are.
// Refused: this host and "any", private, CGNAT (which includes Tailscale), loopback, link-local,
// multicast and reserved IPv4; unique-local, link-local, multicast, loopback and unspecified
// IPv6; and every IPv6 form that carries an IPv4 address inside it (mapped, NAT64, 6to4,
// Teredo), because those reach a private host through a public-looking name.

import net from "node:net";

/** @type {[number, number][]} [base, prefix] */
const V4_BLOCKED = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
  [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15],
  [0xc0586300, 24], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

/** @param {string} ip */
function v4ToInt(ip) { return ip.split(".").reduce((n, p) => n * 256 + Number(p), 0); }

/** @param {string} ip a dotted IPv4 address */
export function isBlockedV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

/** Expand an IPv6 address to eight 16-bit groups, or null when it is not valid. */
function groups6(ip) {
  let s = ip.split("%")[0].toLowerCase();
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) { const n = v4ToInt(v4[2]); s = `${v4[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...tail].map(g => parseInt(g, 16));
  return all.length === 8 && all.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

/** @param {string} ip */
export function isBlockedV6(ip) {
  const g = groups6(ip);
  if (!g) return true;
  if (g.every(x => x === 0)) return true;                                   // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;         // ::1
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return isBlockedV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // mapped
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;                        // NAT64
  if (g[0] === 0x2002) return true;                                         // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true;                           // Teredo
  if ((g[0] & 0xfe00) === 0xfc00) return true;                              // unique-local, Tailscale included
  if ((g[0] & 0xffc0) === 0xfe80) return true;                              // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                              // site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true;                              // multicast
  if (g[0] === 0 ) return true;                                             // ::/16 leftovers (v4-compatible)
  return false;
}

/** True when a child may be sent to this address. Anything that is not an IP is refused. */
export function isPublicAddress(ip) {
  const kind = net.isIP(String(ip));
  if (kind === 4) return !isBlockedV4(ip);
  if (kind === 6) return !isBlockedV6(ip);
  return false;
}
