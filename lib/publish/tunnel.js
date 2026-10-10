// @ts-check
// The box end of the Publish tunnel (the box has no public port). The relay accepts public TLS on 443, reads the SNI, and sends the bytes through ONE outbound stream
// per Space edge to the box (tailnet's relay side, the transport is theirs). This end takes each stream the transport hands it and connects it to Caddy's loopback port, and
// nothing else:
//   - the target is fixed at construction (TUNNEL_PORT on 127.0.0.1); a stream never names an address, so a hostile relay cannot make the box dial anything
//   - the bytes stay ciphertext (TLS passthrough: certificates live in Caddy on the box). This end reads only the first TLS record to find the SNI, and refuses a name that is not
//     one of this Space's hosts, so the relay cannot push a stream for another name through; the relay's own directory check is the first gate, this is the second
//   - limits per stream (idle, lifetime, bytes) and per Space edge (open streams)
//   - the visitor's address, which the relay names on its own authenticated channel, goes to the target in a PROXY v2 header ahead of the TLS bytes (lib/publish/proxy.js), because this end
//     connects from loopback and the target would otherwise see every stranger as 127.0.0.1 and limit them all as one. A stream with no usable address is refused, never sent without one.
// No dependency but node:net. The transport is injected: a stream is any duplex (`on("data")`, `write`, `end`, `destroy`).
import net from "node:net";
import { TUNNEL_PORT } from "./edge.js";
import { encodeProxyV2 } from "./proxy.js";

/** The hosts a stream may ask for: the space name, anything under it, and own domains the directory shows as verified (given by the caller, never by the relay). @param {string} name @param {string} host @param {string[]} [own] */
export function mayServe(name, host, own = []) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h)) return false;
  const n = String(name).toLowerCase();
  if (h === n || h.endsWith(`.${n}`)) return true;
  return own.some(d => { const o = String(d).toLowerCase(); return h === o || h === `www.${o}`; });
}

/**
 * The server name in a TLS ClientHello, or null (not a ClientHello, no SNI, or malformed). `incomplete` is true when more bytes may complete it.
 * @param {Uint8Array} buf @returns {{ host: string | null, incomplete: boolean }}
 */
export function parseSni(buf) {
  const no = { host: null, incomplete: false }, more = { host: null, incomplete: true };
  if (buf.length < 5) return buf.length === 0 || buf[0] === 0x16 ? more : no;
  if (buf[0] !== 0x16 || buf[1] !== 3) return no;
  const recLen = (buf[3] << 8) | buf[4];
  if (recLen < 42 || recLen > 16384) return no;
  if (buf.length < 5 + recLen) return more;
  const end = 5 + recLen;
  let p = 5;
  if (buf[p] !== 0x01) return no; // ClientHello
  p += 4; // type and 3-byte length
  p += 2 + 32; // version, random
  const need = (/** @type {number} */ n) => p + n <= end;
  if (!need(1)) return no;
  p += 1 + buf[p]; // session id
  if (!need(2)) return no;
  p += 2 + ((buf[p] << 8) | buf[p + 1]); // cipher suites
  if (!need(1)) return no;
  p += 1 + buf[p]; // compression
  if (!need(2)) return no;
  const extEnd = Math.min(end, p + 2 + ((buf[p] << 8) | buf[p + 1]));
  p += 2;
  while (p + 4 <= extEnd) {
    const type = (buf[p] << 8) | buf[p + 1], len = (buf[p + 2] << 8) | buf[p + 3];
    p += 4;
    if (p + len > extEnd) return no;
    if (type === 0) { // server_name
      let q = p + 2;
      const listEnd = p + len;
      while (q + 3 <= listEnd) {
        const nt = buf[q], nl = (buf[q + 1] << 8) | buf[q + 2];
        q += 3;
        if (q + nl > listEnd) return no;
        if (nt === 0) return { host: Buffer.from(buf.subarray(q, q + nl)).toString("latin1"), incomplete: false };
        q += nl;
      }
      return no;
    }
    p += len;
  }
  return no;
}

/**
 * The tunnel end for one Space edge.
 * @param {{ name: string | (() => string | null), own?: () => string[], port?: number | (() => number | null), proxy?: boolean, maxStreams?: number, idleMs?: number, lifeMs?: number, maxBytes?: number, helloBytes?: number, helloMs?: number, log?: (what: string, x?: any) => void, connect?: (port: number) => net.Socket }} cfg
 *   `own` answers the verified own domains right now (the directory's answer, cached by the caller). `proxy: false` sends the bytes with no header (a target that does not read one).
 */
export function createTunnelEnd(cfg) {
  /** The loopback port streams go to, read at each stream (a box's public gate takes its port when it starts). */
  const portNow = () => (typeof cfg.port === "function" ? cfg.port() : cfg.port ?? TUNNEL_PORT);
  const nameNow = () => (typeof cfg.name === "function" ? cfg.name() : cfg.name);
  const maxStreams = cfg.maxStreams ?? 256, idleMs = cfg.idleMs ?? 120_000, lifeMs = cfg.lifeMs ?? 3_600_000, maxBytes = cfg.maxBytes ?? 16 * 1024 ** 3, helloBytes = 16 * 1024 + 5, helloMs = cfg.helloMs ?? 10_000;
  const log = cfg.log || (() => {});
  const connect = cfg.connect || ((/** @type {number} */ p) => net.connect({ host: "127.0.0.1", port: p }));
  /** @type {Set<any>} */ const open = new Set();
  const stats = { accepted: 0, refused: /** @type {Record<string, number>} */ ({}), bytes: 0 };
  const refuse = (/** @type {any} */ stream, /** @type {string} */ why) => { stats.refused[why] = (stats.refused[why] || 0) + 1; log("tunnel.refused", { why }); try { stream.destroy(); } catch { /* gone */ } };

  /** Take one stream from the transport. @param {any} stream @param {{ ip?: string, port?: number }} [visitor] the address the relay saw */
  function accept(stream, visitor) {
    if (open.size >= maxStreams) return refuse(stream, "too_many");
    const header = cfg.proxy === false ? null : encodeProxyV2(String(visitor && visitor.ip || ""), Number(visitor && visitor.port));
    if (cfg.proxy !== false && !header) return refuse(stream, "no_address");
    open.add(stream);
    /** @type {net.Socket | null} */ let up = null;
    /** @type {Buffer[]} */ let held = [];
    let heldLen = 0, upBytes = 0, downBytes = 0, done = false;
    /** @type {any} */ let idle = null, life = null, hello = null;
    const end = (/** @type {string} */ why) => {
      if (done) return; done = true;
      clearTimeout(idle); clearTimeout(life); clearTimeout(hello); open.delete(stream);
      // a stream that hit a byte cap is ended with a FIN so the visitor sees a closed connection, not a reset; the reason is logged and counted either way
      try { if (why === "bytes_up" || why === "bytes_down") stream.end(); else stream.destroy(); } catch { /* gone */ }
      try { up && up.destroy(); } catch { /* gone */ }
      if (why !== "closed") log("tunnel.closed", { why });
    };
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => end("idle"), idleMs); idle.unref?.(); };
    life = setTimeout(() => end("lifetime"), lifeMs); life.unref?.();
    hello = setTimeout(() => { if (!up) { stats.refused.no_hello = (stats.refused.no_hello || 0) + 1; end("no_hello"); } }, helloMs); hello.unref?.();
    touch();
    stream.on("error", () => end("error"));
    stream.on("close", () => end("closed"));
    stream.on("data", (/** @type {Buffer} */ chunk) => {
      if (done) return;
      touch();
      upBytes += chunk.length; stats.bytes += chunk.length;
      if (upBytes > maxBytes) return end("bytes_up");
      if (up) { if (!up.write(chunk)) { stream.pause?.(); up.once("drain", () => stream.resume?.()); } return; }
      held.push(chunk); heldLen += chunk.length;
      const sni = parseSni(Buffer.concat(held, heldLen));
      if (sni.host === null && sni.incomplete && heldLen < helloBytes) return;
      if (sni.host === null) { stats.refused.no_sni = (stats.refused.no_sni || 0) + 1; return end("no_sni"); }
      const myName = nameNow();
      if (!myName || !mayServe(myName, sni.host, cfg.own ? cfg.own() : [])) { stats.refused.foreign_name = (stats.refused.foreign_name || 0) + 1; return end("foreign_name"); }
      clearTimeout(hello);
      stats.accepted++;
      const target = portNow();
      if (!target) { stats.refused.no_target = (stats.refused.no_target || 0) + 1; return end("no_target"); }
      up = connect(target);
      up.on("error", () => end("upstream"));
      up.on("close", () => end("closed"));
      up.on("data", (/** @type {Buffer} */ c) => { if (done) return; touch(); downBytes += c.length; stats.bytes += c.length; if (downBytes > maxBytes) return end("bytes_down"); if (!stream.write(c)) { up && up.pause(); stream.once?.("drain", () => up && up.resume()); } });
      up.write(Buffer.concat(header ? [header, ...held] : held, (header ? header.length : 0) + heldLen)); held = []; heldLen = 0;
    });
  }
  return { accept, stats, open: () => open.size, closeAll: () => { for (const s of [...open]) try { s.destroy(); } catch { /* gone */ } open.clear(); } };
}
