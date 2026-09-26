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
import { execFile } from "node:child_process";

const V4 = new net.BlockList();
V4.addSubnet("100.64.0.0", 10, "ipv4");
const V6 = new net.BlockList();
V6.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/** An IPv4-mapped IPv6 address is the IPv4 address. */
export const normalize = ip => {
  const s = String(ip || "");
  return s.startsWith("::ffff:") && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
};

/** Is this a Tailscale address? */
export function isTailnet(ip) {
  const a = normalize(ip);
  return net.isIPv4(a) ? V4.check(a, "ipv4") : net.isIPv6(a) ? V6.check(a, "ipv6") : false;
}

/** The tailscale CLI: on the PATH, or inside the Mac app. */
function tailscaleBin() {
  const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  return process.platform === "darwin" && fs.existsSync(app) ? app : "tailscale";
}

/**
 * `tailscale whois --json <ip>`, reduced to what the link needs. Null when Tailscale does not know
 * the address or is not running.
 * @returns {Promise<{ stableId: string, node: string, login: string|null, tagged: boolean } | null>}
 */
export function whois(ip) {
  return new Promise(resolve => {
    execFile(tailscaleBin(), ["whois", "--json", normalize(ip)], { timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(out);
        const tags = (j.Node && j.Node.Tags) || [];
        resolve({ stableId: String(j.Node.StableID || ""), node: String(j.Node.Name || "").replace(/\.$/, ""),
          login: tags.length ? null : (j.UserProfile && j.UserProfile.LoginName) || null, tagged: tags.length > 0 });
      } catch { resolve(null); }
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
   */
  function open(method, path, { body, headers = {}, timeout = 10_000, onResponse }) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = lib.request({ protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, path, method, timeout, agent: false,
        headers: { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } });
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
