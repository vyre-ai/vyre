// @ts-check
// transport — how the Mac's vyred talks to the box's vyred over the tailnet.
//
// The Mac is a client of the box's tailnet listener (ADR 0002): HTTPS to the box's address, no
// Origin, identified on the box by `tailscale whois` of the Mac's WireGuard address. This file
// adds the other direction of that trust. Before a byte of a request is sent, the peer the socket
// actually connected to is looked up with `tailscale whois` on the Mac, and it must be the box
// node that was pinned when the two were paired. So a changed DNS record, or anything else that
// answers at the box's name, cannot pose as the box: it is not that node.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { isTailnet } from "../../lib/netguard.js";

/** An IPv4-mapped IPv6 address is the IPv4 address. */
export const normalize = ip => {
  const s = String(ip || "");
  return s.startsWith("::ffff:") && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
};

/** Is this a Tailscale address? */
export { isTailnet };

export const REAL_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/**
 * The tailscale CLI: VYRE_TAILSCALE_BIN when set (tests point it at a fake), else the Mac app's
 * binary, else `tailscale` on the PATH. Under `node --test` the real one is never used unless a
 * test opts in with VYRE_TEST_REAL_TAILSCALE=1: a test that starts vyred or runs `vyre up` on a
 * Mac would otherwise query the user's own Tailscale. Null means "no tailscale here", which every
 * caller already treats as an unknown peer.
 * @returns {string|null}
 */
export function tailscaleBin() {
  if (process.env.VYRE_TAILSCALE_BIN) return process.env.VYRE_TAILSCALE_BIN;
  if (process.env.NODE_TEST_CONTEXT && process.env.VYRE_TEST_REAL_TAILSCALE !== "1") return null;
  return process.platform === "darwin" && fs.existsSync(REAL_APP) ? REAL_APP : "tailscale";
}

/**
 * The fields Vyre reads from `tailscale whois --json`. A tagged node has no person behind it,
 * whatever profile it reports. `caps` is the whois CapMap: the application capabilities the
 * tailnet policy grants that peer toward this node (ADR 0014), as the policy wrote them. Vyre
 * reads them and never writes them. Pure, for tests.
 * @returns {{ stableId: string, node: string, login: string|null, tagged: boolean, tags: string[], caps: Record<string, any[]> } | null}
 */
export function parseWhois(w) {
  if (!w || !w.Node) return null;
  const tags = Array.isArray(w.Node.Tags) ? w.Node.Tags.map(String) : [];
  /** @type {Record<string, any[]>} */
  const caps = {};
  for (const [k, v] of Object.entries(w.CapMap && typeof w.CapMap === "object" ? w.CapMap : {})) caps[k] = Array.isArray(v) ? v : [];
  return {
    stableId: String(w.Node.StableID || w.Node.ID || ""),
    node: String(w.Node.Name || w.Node.ComputedName || "").replace(/\.$/, ""),
    login: tags.length ? null : (w.UserProfile && w.UserProfile.LoginName) || null,
    tagged: tags.length > 0,
    tags,
    caps,
  };
}

/** The values the policy granted a peer for one capability, or [] (the peer has none). */
export const capValues = (who, name) => (who && who.caps && Array.isArray(who.caps[name]) ? who.caps[name] : []);

/**
 * `tailscale whois --json <ip>`, reduced to parseWhois. Null when Tailscale does not know the
 * address or is not running.
 */
export function whois(ip) {
  const bin = tailscaleBin();
  if (!bin) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile(bin, ["whois", "--json", normalize(ip)], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(parseWhois(JSON.parse(out))); } catch { resolve(null); }
    });
  });
}

/**
 * The default check of the peer a connection reached: a tailnet address that whois knows. The
 * caller compares the answer with the pinned node.
 * @param {string} ip
 */
export async function identifyBox(ip) {
  if (!isTailnet(ip)) return null;
  return whois(ip);
}

/**
 * Build the requester for one box.
 * @param {{ address: string, verify: (ip: string) => Promise<{ stableId: string, node?: string } | null>,
 *   pinned: () => string|null, insecure?: boolean, ttl?: number }} opts
 * `pinned` is the box node's stable ID, or null while pairing (the first connection is what pins it).
 */
export function connector({ address, verify, pinned, insecure = false, ttl = 60_000 }) {
  const base = new URL(address);
  if (base.protocol !== "https:" && !(insecure && base.protocol === "http:")) throw new Error("the box's address must be https://");
  const lib = base.protocol === "https:" ? https : http;
  /** @type {Map<string, { at: number, who: any }>} */
  const cache = new Map();

  /** Check the socket's peer before anything is written to it. Resolves to the node, or throws. */
  async function check(socket) {
    const ip = normalize(socket.remoteAddress);
    let hit = cache.get(ip);
    if (!hit || Date.now() - hit.at >= ttl) { hit = { at: Date.now(), who: await verify(ip) }; cache.set(ip, hit); }
    const who = hit.who;
    if (!who || !who.stableId) throw Object.assign(new Error("the box's address did not reach a node on your tailnet"), { code: "not_box" });
    const pin = pinned();
    if (pin && who.stableId !== pin) throw Object.assign(new Error("the box's address reached a different node than the one you paired"), { code: "not_box" });
    return who;
  }

  /**
   * Open a request once the peer is checked. `onResponse` gets the response; the returned promise
   * resolves with the peer node and the request, or rejects when the box cannot be reached.
   * `signal` ends the request early, as when the Mac stops while it holds a link.serve open.
   * @param {string} method @param {string} path
   * @param {{ body?: any, headers?: Record<string, any>, timeout?: number, signal?: AbortSignal, onResponse: (res: any) => void }} opts
   */
  function open(method, path, { body, headers = {}, timeout = 10_000, signal, onResponse }) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(Object.assign(new Error("the request was cancelled"), { code: "aborted" }));
      // A Buffer body (sync.upload's chunks) goes as-is, octet-stream; anything else is JSON, as
      // every other call here has always sent it.
      const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
      const req = lib.request({ protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, path, method, timeout, agent: false,
        headers: { accept: "application/json", ...(Buffer.isBuffer(data) ? { "content-type": "application/octet-stream", "content-length": data.length }
          : data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } });
      let who = null;
      req.on("socket", socket => {
        const go = () => check(socket).then(w => { who = w; if (data) req.write(data); req.end(); }).catch(e => { req.destroy(e); });
        // Nothing is written until the peer is checked. With TLS, wait for the handshake as well,
        // so the certificate has been verified too. agent: false means a fresh socket every time.
        if (base.protocol === "https:") socket.once("secureConnect", go);
        else if (socket.connecting) socket.once("connect", go);
        else go();
      });
      req.on("response", res => { onResponse(res); resolve({ who, req }); });
      req.on("timeout", () => req.destroy(Object.assign(new Error("the box did not answer in time"), { code: "timeout" })));
      req.on("error", reject);
      if (signal) {
        const abort = () => req.destroy(Object.assign(new Error("the request was cancelled"), { code: "aborted" }));
        signal.addEventListener("abort", abort, { once: true });
        req.on("close", () => signal.removeEventListener("abort", abort));
      }
    });
  }

  /** One JSON request. Resolves to the box's { data } or { error } body, with the node it came from. */
  async function json(method, path, body, opts = {}) {
    let raw = "", status = 0, finish = () => {}, fail = e => {};
    const ended = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const { who } = await open(method, path, { body, ...opts, onResponse: res => {
      status = res.statusCode || 0;
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; if (raw.length > 8_000_000) res.destroy(new Error("the box's answer is too large")); });
      res.on("end", () => finish(undefined));
      res.on("error", fail);
      res.on("aborted", () => fail(new Error("the box closed the connection")));
    } });
    await ended;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { error: { code: "bad_response", message: `the box answered ${status} with something that is not JSON` } }; }
    return { body: parsed, status, who };
  }

  return { address: base.href.replace(/\/$/, ""), open, json };
}

/**
 * The owner's tailnet peers that are online: where a box could be.
 * @returns {Promise<{ ip: string, dns: string, stableId: string, host: string }[]>}
 */
export function tailnetPeers() {
  const bin = tailscaleBin();
  if (!bin) return Promise.resolve([]);
  return new Promise(resolve => {
    execFile(bin, ["status", "--json"], { timeout: 5000, maxBuffer: 8_000_000 }, (err, out) => {
      if (err) return resolve([]);
      try {
        const peers = Object.values(JSON.parse(out).Peer || {});
        resolve(peers.filter(p => p.Online && (p.TailscaleIPs || []).length).map(p => ({
          ip: p.TailscaleIPs.find(a => net.isIPv4(a)) || p.TailscaleIPs[0], dns: String(p.DNSName || "").replace(/\.$/, ""),
          stableId: String(p.ID || ""), host: String(p.HostName || "") })));
      } catch { resolve([]); }
    });
  });
}

/**
 * The names a peer's certificate on 443 is for. The box may serve `<you>.vyre.run` rather than its
 * ts.net name, and that is the name the Mac must use (the box checks Host). Nothing is sent: the
 * handshake is only read, then closed; the real connection verifies the certificate as usual.
 * @returns {Promise<string[]>}
 */
export function certNames(ip, servername, timeout = 1500, port = 443) {
  return new Promise(resolve => {
    const s = tls.connect({ host: ip, port, servername: servername || undefined, rejectUnauthorized: false, timeout }, () => {
      const alt = String((s.getPeerCertificate() || {}).subjectaltname || "");
      s.destroy();
      resolve(alt.split(/,\s*/).filter(x => x.startsWith("DNS:")).map(x => x.slice(4)).filter(n => !n.includes("*")));
    });
    s.on("error", () => resolve([]));
    s.on("timeout", () => { s.destroy(); resolve([]); });
  });
}
