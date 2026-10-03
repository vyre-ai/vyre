// @ts-check
// peer-channel: the Node side of the Wink forwarder (EC-1, EC-2).
//
// The forwarder (wink/forwarder, Go) accepts each peer connection as a tsnet node, asks its own
// LocalAPI who the remote address is, and connects to the Unix socket this module listens on. It
// writes a framed header with the node key BEFORE the first byte of the peer's stream. This socket
// is a channel of its own: it is never the socket or port the Deck, the CLI or an agent uses, so a
// peer can never be mistaken for a local caller, and identity is never read from the source
// address (which is loopback behind a userspace tailscaled) or from anything the peer sent.
//
// Framing (the forwarder writes it exactly once per connection):
//   magic   4 bytes  "WKH1"
//   length  4 bytes  unsigned big endian, 1..4096
//   header  length bytes of UTF-8 JSON: {"v":1,"nodeKey","stableId","tags","remoteAddr"}
//   stream  the peer's bytes verbatim, both directions
// A missing magic, a bad length, a header that is not exactly that JSON, a node key, id, tag or
// address of the wrong shape, a loopback remote address, or no header within two seconds: the
// connection is destroyed and onRefuse is told why. Bytes that arrive after the header are
// handed to onPeer untouched (pushed back onto the connection).
//
// Who may connect (the SO_PEERCRED stand-in): Node has no peer-credential call, so the socket
// lives in a directory owned by this uid with mode 0700, is itself 0600, and both are re-checked on
// every accepted connection; if either was widened or replaced the connection is refused and
// the listener closes. A process of another uid cannot reach it by path. A same-uid process can,
// which is the same-user limit the threat model lists (12.2).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

export const MAGIC = Buffer.from("WKH1", "latin1");
export const MAX_HEADER = 4096;
export const HEADER_TIMEOUT_MS = 2000;

const NODEKEY = /^nodekey:[0-9a-f]{64}$/;
const STABLE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TAG = /^tag:[a-z0-9][a-z0-9-]{0,62}$/;

/** True for an address inside the tailnet ranges (100.64.0.0/10, fd7a:115c:a1e0::/48). */
function tailnetIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  if (net.isIPv6(ip)) return /^fd7a:115c:a1e0:/i.test(ip);
  return false;
}

/** @param {string} s ip:port or [ip]:port @returns {{ ip: string, port: number } | null} */
function splitAddr(s) {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(s) || /^([0-9.]+):(\d{1,5})$/.exec(s);
  if (!m) return null;
  const port = Number(m[2]);
  if (!net.isIP(m[1]) || port < 1 || port > 65535) return null;
  return { ip: m[1], port };
}

/**
 * Encode a header the way the forwarder does (used by the fake forwarder in tests).
 * @param {{ nodeKey: string, stableId: string, tags?: string[], remoteAddr: string }} id
 */
export function encodeHeader(id) {
  const body = Buffer.from(JSON.stringify({ v: 1, nodeKey: id.nodeKey, stableId: id.stableId, tags: id.tags || [], remoteAddr: id.remoteAddr }), "utf8");
  if (body.length > MAX_HEADER) throw new Error("header too large");
  const head = Buffer.alloc(8);
  MAGIC.copy(head, 0);
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

/**
 * Parse the 8-byte prefix and the body. Returns { need } while bytes are missing.
 * @param {Buffer} buf
 * @returns {{ need: number } | { error: string } | { id: { nodeKey: string, stableId: string, tags: string[], remoteAddr: string }, used: number }}
 */
export function decodeHeader(buf) {
  if (buf.length >= 4 && !buf.subarray(0, 4).equals(MAGIC)) return { error: "bad magic" };
  if (buf.length < 8) return { need: 8 - buf.length };
  const len = buf.readUInt32BE(4);
  if (len < 1 || len > MAX_HEADER) return { error: "bad length" };
  if (buf.length < 8 + len) return { need: 8 + len - buf.length };
  let j;
  try { j = JSON.parse(buf.subarray(8, 8 + len).toString("utf8")); } catch { return { error: "header is not JSON" }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { error: "header is not an object" };
  const allowed = new Set(["v", "nodeKey", "stableId", "tags", "remoteAddr"]);
  for (const k of Object.keys(j)) if (!allowed.has(k)) return { error: `unknown header field ${k}` };
  if (j.v !== 1) return { error: "unsupported version" };
  if (typeof j.nodeKey !== "string" || !NODEKEY.test(j.nodeKey)) return { error: "bad node key" };
  if (typeof j.stableId !== "string" || !STABLE_ID.test(j.stableId)) return { error: "bad stable id" };
  if (!Array.isArray(j.tags) || j.tags.length > 16 || j.tags.some(t => typeof t !== "string" || !TAG.test(t))) return { error: "bad tags" };
  if (typeof j.remoteAddr !== "string") return { error: "bad remote address" };
  const a = splitAddr(j.remoteAddr);
  if (!a) return { error: "bad remote address" };
  if (!tailnetIp(a.ip)) return { error: "remote address is not a tailnet address" };
  return { id: { nodeKey: j.nodeKey, stableId: j.stableId, tags: j.tags, remoteAddr: j.remoteAddr }, used: 8 + len };
}

/** @param {string} dir @param {string} sock @param {number | null} uid */
function pathProblem(dir, sock, uid) {
  try {
    const d = fs.lstatSync(dir);
    if (!d.isDirectory() || d.isSymbolicLink()) return "socket directory is not a plain directory";
    if (process.platform !== "win32") {
      if (uid != null && d.uid !== uid) return "socket directory has another owner";
      if ((d.mode & 0o077) !== 0) return "socket directory is open to group or others";
      const s = fs.lstatSync(sock);
      if (!s.isSocket()) return "socket path is not a socket";
      if (uid != null && s.uid !== uid) return "socket has another owner";
      if ((s.mode & 0o077) !== 0) return "socket is open to group or others";
    }
    return null;
  } catch (e) { return `socket path unreadable: ${/** @type {any} */ (e).code || e}`; }
}

/**
 * Listen for forwarded peers.
 * @param {{ path: string,
 *   onPeer: (conn: net.Socket, id: { nodeKey: string, stableId: string, tags: string[], remoteAddr: string }) => void,
 *   onRefuse?: (why: string) => void, uid?: number | null, headerTimeoutMs?: number }} opts
 * @returns {Promise<{ path: string, close: () => Promise<void>, stats: { accepted: number, refused: number } }>}
 */
export async function listenPeers(opts) {
  const sock = path.resolve(opts.path);
  const dir = path.dirname(sock);
  const uid = opts.uid === undefined ? (process.getuid ? process.getuid() : null) : opts.uid;
  const timeout = opts.headerTimeoutMs ?? HEADER_TIMEOUT_MS;
  if (process.platform !== "win32") {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const d = fs.lstatSync(dir);
    if (uid != null && d.uid !== uid) throw new Error("peer-channel: socket directory has another owner");
    if ((d.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }
  try { if (fs.lstatSync(sock).isSocket()) fs.unlinkSync(sock); } catch { /* none */ }
  const stats = { accepted: 0, refused: 0 };
  const refuse = (/** @type {net.Socket} */ c, /** @type {string} */ why) => {
    stats.refused++;
    c.destroy();
    try { opts.onRefuse?.(why); } catch { /* the reporter must not break the listener */ }
  };
  /** @type {net.Server} */
  const server = net.createServer(c => {
    const problem = pathProblem(dir, sock, uid);
    if (problem) { refuse(c, problem); server.close(); return; }
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => refuse(c, "no header in time"), timeout);
    c.on("error", () => { clearTimeout(timer); });
    const onData = (/** @type {Buffer} */ chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const r = decodeHeader(buf);
      if ("need" in r) return;
      c.removeListener("data", onData);
      c.pause();
      clearTimeout(timer);
      if ("error" in r) return refuse(c, r.error);
      const rest = buf.subarray(r.used);
      if (rest.length) c.unshift(rest);
      stats.accepted++;
      opts.onPeer(c, r.id);
    };
    c.on("data", onData);
    c.on("close", () => clearTimeout(timer));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(sock, () => resolve(undefined)); });
  if (process.platform !== "win32") fs.chmodSync(sock, 0o600);
  return {
    path: sock, stats,
    close: () => new Promise(resolve => { server.close(() => { try { fs.unlinkSync(sock); } catch { /* gone */ } resolve(); }); }),
  };
}
