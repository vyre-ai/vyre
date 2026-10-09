// @ts-check
// Which addresses a session's "internet" may reach (the egress proxy's internet mode): the public ones. The decision is made on the 16 BYTES of
// the address, never on its text (reviewer-3 NG-1: "::ffff:7f00:1" is loopback in hex and slipped past a text check). Every literal and every
// resolved answer is parsed to bytes, any embedded IPv4 is unwrapped (IPv4-mapped, IPv4-compatible, NAT64, 6to4; the SIIT range is refused outright), and one deny list is
// applied to the result: loopback, private, link-local, carrier-grade NAT, unique-local, multicast, unspecified, documentation and special ranges,
// the cloud metadata addresses, and every address this machine itself has. The proxy resolves the name itself, requires EVERY answer to be
// public, connects to the exact address it checked, and re-checks the connected socket's remote address.

import dns from "node:dns";
import net from "node:net";
import os from "node:os";

/** @param {string} s @returns {Buffer|null} 16 bytes, or null when the text is not a literal address */
export function toBytes(s) {
  let a = String(s).trim().toLowerCase();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  if (a.includes("%")) return null;                                    // a zone id is never a public destination
  if (net.isIPv4(a)) { const p = a.split(".").map(Number); return Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, p[0], p[1], p[2], p[3]]); }
  if (!net.isIPv6(a)) return null;
  // An embedded dotted IPv4 tail ("::ffff:1.2.3.4") becomes two hex groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (tail) { const p = tail[1].split(".").map(Number); a = a.slice(0, a.length - tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16); }
  const [head, rest, extra] = a.split("::");
  if (extra !== undefined) return null;
  const h = head ? head.split(":") : [], r = rest !== undefined && rest !== "" ? rest.split(":") : [];
  if (rest === undefined && h.length !== 8) return null;
  const fill = rest === undefined ? [] : Array(8 - h.length - r.length).fill("0");
  const groups = [...h, ...fill, ...r];
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) { if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null; out.writeUInt16BE(parseInt(groups[i], 16), i * 2); }
  return out;
}

/** Is this IPv4 (4 bytes) a public one? @param {number[]|Buffer} p */
function publicV4(p) {
  const [a, b, c] = [p[0], p[1], p[2]];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;               // this network, private, loopback, multicast and reserved, broadcast
  if (a === 100 && b >= 64 && b <= 127) return false;                            // carrier-grade NAT (includes tailnet addresses)
  if (a === 169 && b === 254) return false;                                      // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;                // IETF protocol, documentation
  if (a === 192 && b === 88 && c === 99) return false;                           // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false;                         // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;                          // documentation
  if (a === 203 && b === 0 && c === 113) return false;                           // documentation
  return true;
}

const zero = (b, from, to) => { for (let i = from; i < to; i++) if (b[i] !== 0) return false; return true; };

/** @param {Buffer} b the 16 bytes */
function publicBytes(b) {
  if (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return publicV4(b.subarray(12));          // ::ffff:0:0/96 mapped
  if (zero(b, 0, 12)) return publicV4(b.subarray(12));                                              // ::/96 compatible (also :: and ::1)
  if (zero(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return false;                       // ::ffff:0:0:0/96 SIIT: a translator range, never a destination
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {                            // 64:ff9b::/32
    if (zero(b, 4, 12)) return publicV4(b.subarray(12));                                            // 64:ff9b::/96 NAT64: the IPv4 inside
    return false;                                                                                    // 64:ff9b:1::/48 local-use
  }
  if (b[0] === 0x20 && b[1] === 0x02) return publicV4(b.subarray(2, 6));                             // 2002::/16 6to4: the IPv4 inside
  if ((b[0] & 0xe0) !== 0x20) return false;                                                          // only 2000::/3 is global unicast
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] & 0xfe) === 0x00) return false;                        // 2001::/23 protocol assignments, Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false;                // 2001:db8::/32 documentation
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) return false;                        // 3fff::/20 documentation
  return true;
}

/** The IPv4 an IPv6 address carries inside it (mapped, compatible, NAT64 /96, 6to4), as 4 bytes, or null. @param {Buffer} b the 16 bytes */
function embeddedV4(b) {
  if (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return b.subarray(12);
  if (zero(b, 0, 12)) return b.subarray(12);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(b, 4, 12)) return b.subarray(12);
  if (b[0] === 0x20 && b[1] === 0x02) return b.subarray(2, 6);
  return null;
}

/**
 * What an IP literal is, in any spelling, decided on its bytes: "loopback" (127.0.0.0/8 and ::1, also when carried inside an IPv6 address), "public", or "refused" (every other range the deny
 * list names: private, tailnet, link-local, metadata, unspecified, multicast, unique-local, documentation, special). null when the text is not an IP literal. This is the ONE place that
 * answers the question; every other check in the repo calls it (test/netguard-single.test.js keeps it so). It does not know this machine's own addresses; isPublicAddress adds those.
 * @param {string} ip @returns {"loopback"|"public"|"refused"|null}
 */
export function classifyAddress(ip) {
  const zoned = String(ip).includes("%");
  const b = toBytes(zoned ? String(ip).replace(/%.*$/, "") : ip);
  if (!b) return null;
  const e = embeddedV4(b);
  if ((e && e[0] === 127) || (zero(b, 0, 15) && b[15] === 1)) return "loopback";
  return publicBytes(b) && !zoned ? "public" : "refused";                                                  // a zone id is never a public destination
}

/**
 * Does this IPv6 literal carry an IPv4 address in a tunnel or translator form (compatible ::a.b.c.d, NAT64, 6to4, Teredo)? A caller that wants no such path at all (the module egress) refuses these
 * on top of isPublicAddress, which only follows the embedded address. IPv4-mapped (::ffff:a.b.c.d) is not one.
 * @param {string} ip
 */
export function isTunnelAddress(ip) {
  const b = toBytes(ip);
  if (!b) return false;
  const mapped = zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff;
  if (mapped) return false;
  return embeddedV4(b) !== null || (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0);
}

/**
 * Is this IP on a private network a person could own: loopback, RFC 1918 (10/8, 172.16/12, 192.168/16), the tailnet / carrier-grade range, link-local, or IPv6 unique-local, in any spelling? The
 * opposite question to isPublicAddress, for "plain http is fine to my own network" (it is false for multicast, unspecified and documentation ranges, which are no one's network).
 * @param {string} ip
 */
export function isPrivateNetwork(ip) {
  const b = toBytes(ip);
  if (!b) return false;
  if (classifyAddress(ip) === "loopback") return true;
  const e = embeddedV4(b);
  const v4 = e || (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff ? b.subarray(12) : null);
  if (v4) return v4[0] === 10 || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] === 192 && v4[1] === 168) || (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127) || (v4[0] === 169 && v4[1] === 254);
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80);
}

/** Is this host this machine: localhost, or a loopback address in any spelling? @param {string} h */
export const isLoopbackHost = h => String(h).trim().toLowerCase() === "localhost" || classifyAddress(h) === "loopback";

/** Is this IP in the tailnet's own space: 100.64.0.0/10 (also mapped into IPv6) or fd7a:115c:a1e0::/48? @param {string} ip */
export function isTailnet(ip) {
  const b = toBytes(ip);
  if (!b) return false;
  if (b[0] === 0xfd && b[1] === 0x7a && b[2] === 0x11 && b[3] === 0x5c && b[4] === 0xa1 && b[5] === 0xe0) return true;
  const mapped = zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff;
  return mapped && b[12] === 100 && b[13] >= 64 && b[13] <= 127;
}

/** @param {string} ip @param {string[]} [own] */
export function isPublicAddress(ip, own = ownAddresses()) {
  const b = toBytes(ip);
  if (!b) return false;                                                                              // not a literal address: not public
  for (const o of own) { const ob = toBytes(o); if (ob && ob.equals(b)) return false; }
  // A machine's own IPv4 address is also refused in its mapped form (the bytes above are already mapped for IPv4 text).
  return publicBytes(b);
}

/** This machine's own addresses. */
export function ownAddresses() { return Object.values(os.networkInterfaces()).flat().filter(Boolean).map(a => /** @type {any} */ (a).address.toLowerCase().replace(/%.*$/, "")); }

/**
 * Resolve a host to ONE public address, or throw. A literal is checked as it stands; a name is resolved here and EVERY answer must be public.
 * A host in an inet_aton form ("0177.0.0.1", "2130706433", "0x7f.1") or with a zone id is refused outright, and one trailing dot is dropped.
 * @param {string} host @param {{ lookup?: (h: string) => Promise<{ address: string }[]>, own?: string[] }} [o]
 */
export async function resolvePublic(host, o = {}) {
  const own = o.own || ownAddresses();
  if (/[\s\x00-\x1f\x7f]/.test(String(host))) throw Object.assign(new Error("not a public address"), { code: "NOT_PUBLIC" });   // whitespace anywhere, including a trailing space, is refused before anything else
  let h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (h.endsWith(".") && !h.endsWith("..")) h = h.slice(0, -1);
  if (!h || h.includes("%") || /\s/.test(h)) throw Object.assign(new Error("not a public address"), { code: "NOT_PUBLIC" });
  const literal = toBytes(h);
  if (!literal && (h.startsWith(".") || h.split(".").some(l => l === "") || /[^a-z0-9.\-_]/.test(h))) throw Object.assign(new Error("not a public address"), { code: "NOT_PUBLIC" });   // not a clean name: an empty label or a character a host name cannot hold
  if (!literal && /^[0-9a-fx.]+$/.test(h)) throw Object.assign(new Error("not a public address"), { code: "NOT_PUBLIC" });   // numeric forms resolvers read as IPv4
  const list = literal ? [{ address: h }] : await (o.lookup || (n => dns.promises.lookup(n, { all: true })))(h);
  if (!list.length) throw Object.assign(new Error("no address"), { code: "ENOTFOUND" });
  for (const r of list) if (!isPublicAddress(r.address, own)) throw Object.assign(new Error("not a public address"), { code: "NOT_PUBLIC" });
  return list[0].address;
}

/** Is this IP link-local (169.254.0.0/16, which holds the cloud metadata address, or fe80::/10), in any spelling? @param {string} ip */
export function isLinkLocal(ip) {
  const b = toBytes(String(ip).replace(/%.*$/, ""));
  if (!b) return false;
  const e = embeddedV4(b);
  const v4 = e || (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff ? b.subarray(12) : null);
  if (v4) return v4[0] === 169 && v4[1] === 254;
  return b[0] === 0xfe && (b[1] & 0xc0) === 0x80;
}

/**
 * The address a dial to a host the PERSON gave (their own mail server) may use, or a refusal: the user-given counterpart of resolvePublic. The person's own host may sit on the internet, on their
 * private network or on their tailnet, so those pass; loopback passes only when the host is itself a loopback name or address (a public name that resolves to this machine is how a hostile name
 * reaches the daemon's own ports); link-local (the cloud metadata address), unspecified, multicast and every other special range never pass. Every answer for a name must pass, and the first is
 * returned so the caller connects to the address that was checked.
 * @param {string} host @param {{ lookup?: (h: string) => Promise<{ address: string }[]> }} [o]
 * @returns {Promise<{ address: string, kind: "public" | "private" | "loopback" }>}
 */
export async function resolveUserHost(host, o = {}) {
  const refuse = () => Object.assign(new Error("not an address a mail server can be at"), { code: "NOT_ALLOWED" });
  let h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (h.endsWith(".") && !h.endsWith("..")) h = h.slice(0, -1);
  if (!h || /[\s\x00-\x1f\x7f%]/.test(h)) throw refuse();
  const literal = toBytes(h);
  if (!literal && /^[0-9a-fx.]+$/.test(h)) throw refuse();                                            // numeric forms resolvers read as IPv4
  const list = literal ? [{ address: h }] : await (o.lookup || (n => dns.promises.lookup(n, { all: true })))(h);
  if (!list.length) throw Object.assign(new Error("no address"), { code: "ENOTFOUND" });
  const loopbackHost = isLoopbackHost(h);
  /** @type {"public" | "private" | "loopback" | null} */ let first = null;
  for (const r of list) {
    const c = classifyAddress(r.address);
    /** @type {"public" | "private" | "loopback" | null} */
    const kind = c === "loopback" ? (loopbackHost ? "loopback" : null) : c === "public" ? "public" : c === "refused" && isPrivateNetwork(r.address) && !isLinkLocal(r.address) ? "private" : null;
    if (!kind) throw refuse();
    first = first || kind;
  }
  return { address: list[0].address, kind: /** @type {any} */ (first) };
}
