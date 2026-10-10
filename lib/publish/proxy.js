// @ts-check
// The PROXY protocol, version 2, binary form (haproxy.org/download/1.8/doc/proxy-protocol.txt): the one header that carries a visitor's real address through a hop that connects from
// loopback. The tunnel end (lib/publish/tunnel.js) writes it before the visitor's TLS bytes; the public gate (core/wink/control/gate.js) reads it, from loopback peers only, and keys its limits
// on that address instead of 127.0.0.1. Only TCP over IPv4 or IPv6 is written; a reader treats LOCAL and any other family as "keep the peer's own address".
import net from "node:net";

export const PROXY_V2_SIGNATURE = Buffer.from("0d0a0d0a000d0a515549540a", "hex");
/** The most a header may declare (the TLV space a sender could add); anything longer is not ours. */
export const PROXY_V2_MAX = 16 + 536;

/** @param {string} ip an IPv6 address, any spelling @returns {Buffer | null} */
function v6Bytes(ip) {
  if (!net.isIPv6(ip)) return null;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16), i * 2));
  return b;
}

/**
 * The header for one visitor, or null when the address is not a plain IPv4 or IPv6 address (the caller refuses the stream rather than let the gate see loopback).
 * @param {string} ip @param {number} port
 */
export function encodeProxyV2(ip, port) {
  const a = String(ip || "").replace(/^::ffff:/i, "");
  const p = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0;
  if (net.isIPv4(a)) {
    const b = Buffer.alloc(16 + 12);
    PROXY_V2_SIGNATURE.copy(b); b[12] = 0x21; b[13] = 0x11; b.writeUInt16BE(12, 14);
    Buffer.from(a.split(".").map(Number)).copy(b, 16); // source; the destination (bytes 20..23) stays zero
    b.writeUInt16BE(p, 24);
    return b;
  }
  const v6 = v6Bytes(a);
  if (!v6) return null;
  const b = Buffer.alloc(16 + 36);
  PROXY_V2_SIGNATURE.copy(b); b[12] = 0x21; b[13] = 0x21; b.writeUInt16BE(36, 14);
  v6.copy(b, 16);
  b.writeUInt16BE(p, 48);
  return b;
}

/**
 * Read a header from the start of a stream. "none": these bytes are not a PROXY v2 header (a plain connection); "more": a header so far, wait for more bytes; "bad": it starts as one but is not valid;
 * "ok": `length` bytes are the header, and `addr`/`port` are the source it names (null: it names none, keep the peer's own).
 * @param {Buffer} buf
 * @returns {{ state: "none" | "more" | "bad" } | { state: "ok", length: number, addr: string | null, port: number | null }}
 */
export function decodeProxyV2(buf) {
  const n = Math.min(buf.length, 12);
  if (!buf.subarray(0, n).equals(PROXY_V2_SIGNATURE.subarray(0, n))) return { state: "none" };
  if (buf.length < 16) return { state: "more" };
  if ((buf[12] >> 4) !== 2 || (buf[12] & 15) > 1) return { state: "bad" };
  const len = buf.readUInt16BE(14);
  if (len > PROXY_V2_MAX - 16) return { state: "bad" };
  if (buf.length < 16 + len) return { state: "more" };
  const length = 16 + len, fam = buf[13];
  if ((buf[12] & 15) === 0) return { state: "ok", length, addr: null, port: null };
  if (fam === 0x11 && len >= 12) return { state: "ok", length, addr: `${buf[16]}.${buf[17]}.${buf[18]}.${buf[19]}`, port: buf.readUInt16BE(24) };
  if (fam === 0x21 && len >= 36) {
    const g = []; for (let i = 0; i < 8; i++) g.push(buf.readUInt16BE(16 + i * 2).toString(16));
    const mapped = g.slice(0, 5).every(x => x === "0") && g[5] === "ffff";
    return { state: "ok", length, addr: mapped ? `${buf[28]}.${buf[29]}.${buf[30]}.${buf[31]}` : g.join(":"), port: buf.readUInt16BE(48) };
  }
  return { state: "ok", length, addr: null, port: null };
}
