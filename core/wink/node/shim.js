// @ts-check
// shim: the pinning proxy (EC-8).
//
// Stock tailscaled verifies a control server's certificate with Go's trust store, which on macOS and
// Windows is the operating system's. It cannot pin a self-signed certificate there. So the Wink
// core's control URL is http://127.0.0.1:<port>, served here, and this proxy connects to the real
// control address over TLS and VERIFIES THE PINNED KEY from the sealed pairing record. It never uses
// a certificate authority, system or bundled: the handshake runs with verification off and the
// connection is then accepted only if the SHA-256 of the server certificate's SubjectPublicKeyInfo
// equals the pin. No byte of any request goes upstream before that check passes. There is no
// fallback: a mismatch refuses the request and emits `pin-mismatch`.
//
// What it forwards (anything else is answered 403 and reported as `refused`):
//   GET  /key                         the control server's public key
//   GET|POST /ts2021  + Upgrade       the control protocol (Upgrade: tailscale-control-protocol)
//   GET  /derp  + Upgrade: DERP       the relay upgrade on the control address
//   GET  /derp/probe, /derp/latency-check, /generate_204
// It refuses to be pointed at another host, never follows an upstream redirect (a 3xx, or a
// response to an upgrade that is not 101, is turned into a 502 and reported), and rewrites Host
// to the pinned upstream. It listens on 127.0.0.1 only. A DERP server on another address is
// dialled directly by the core from the DERP map, where the pin is the node's `CertName`
// ("sha256-raw:<hex>"); the pairing record carries that map (spec 4.7), not this proxy.

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const MAX_HEAD = 16 * 1024;
const ALLOWED_PLAIN = new Set(["/key", "/derp/probe", "/derp/latency-check", "/generate_204"]);
const UPGRADES = new Map([["/ts2021", "tailscale-control-protocol"], ["/derp", "derp"]]);

/**
 * Normalise a pin: "sha256/<base64>" (HPKP style) or 64 hex characters, to a Buffer.
 * @param {string} pin
 */
export function parsePin(pin) {
  if (typeof pin !== "string") throw new Error("shim: a pin is required");
  const m = /^sha256\/([A-Za-z0-9+/]{43}=)$/.exec(pin);
  if (m) return Buffer.from(m[1], "base64");
  if (/^[0-9a-fA-F]{64}$/.test(pin)) return Buffer.from(pin, "hex");
  throw new Error("shim: pin must be sha256/<base64> or 64 hex characters");
}

/** The SPKI pin of a PEM or DER certificate, in the form parsePin takes. @param {string | Buffer} cert */
export function spkiPin(cert) {
  const x = new crypto.X509Certificate(cert);
  const der = x.publicKey.export({ type: "spki", format: "der" });
  return "sha256/" + crypto.createHash("sha256").update(der).digest("base64");
}

/** @param {Buffer} raw */
function pinOf(raw) {
  const x = new crypto.X509Certificate(raw);
  return crypto.createHash("sha256").update(x.publicKey.export({ type: "spki", format: "der" })).digest();
}

/**
 * @param {{ upstream: string, pin: string, listenPort?: number,
 *   onEvent?: (e: { type: "pin-mismatch" | "refused" | "upstream-error", [k: string]: any }) => void,
 *   connectTimeoutMs?: number }} opts
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>, stats: { proxied: number, upgraded: number, refused: number, pinMismatch: number } }>}
 */
export async function startShim(opts) {
  const want = parsePin(opts.pin);
  const u = new URL(opts.upstream);
  if (u.protocol !== "https:") throw new Error("shim: the upstream must be https");
  if (u.pathname !== "/" || u.search || u.username) throw new Error("shim: the upstream is a bare host:port");
  const host = u.hostname;
  const port = Number(u.port || 443);
  const hostHeader = u.host;
  const emit = (/** @type {any} */ e) => { try { opts.onEvent?.(e); } catch { /* reporter must not break the proxy */ } };
  const stats = { proxied: 0, upgraded: 0, refused: 0, pinMismatch: 0 };

  /** A TLS socket to the upstream that has passed the pin check, or a rejection. */
  function connectPinned() {
    return new Promise((resolve, reject) => {
      const s = tls.connect({
        host, port, servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: false, // no certificate authority is consulted; the pin below is the only check
        minVersion: "TLSv1.2", ALPNProtocols: ["http/1.1"],
      });
      const timer = setTimeout(() => s.destroy(new Error("connect timeout")), opts.connectTimeoutMs ?? 15_000);
      s.once("error", e => { clearTimeout(timer); reject(e); });
      s.once("secureConnect", () => {
        clearTimeout(timer);
        const peer = s.getPeerCertificate(true);
        let got = null;
        try { got = peer && peer.raw ? pinOf(peer.raw) : null; } catch { got = null; }
        if (!got || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
          stats.pinMismatch++;
          emit({ type: "pin-mismatch", host: hostHeader, got: got ? "sha256/" + got.toString("base64") : null });
          s.destroy();
          return reject(Object.assign(new Error("pin mismatch"), { code: "EPINMISMATCH" }));
        }
        s.removeAllListeners("error");
        resolve(s);
      });
    });
  }

  const refuse = (/** @type {http.ServerResponse | net.Socket} */ out, /** @type {number} */ status, /** @type {string} */ why, /** @type {string} */ what) => {
    stats.refused++;
    emit({ type: "refused", why, what });
    if (out instanceof http.ServerResponse) { out.writeHead(status, { "content-type": "text/plain", connection: "close" }); out.end(why + "\n"); }
    else { out.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || "Error"}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); }
  };

  const pathOf = (/** @type {string | undefined} */ url) => {
    if (!url || url[0] !== "/" || url.startsWith("//")) return null;
    try { return new URL(url, "http://x").pathname; } catch { return null; }
  };

  const server = http.createServer(async (req, res) => {
    const p = pathOf(req.url);
    if (!p || !ALLOWED_PLAIN.has(p)) return refuse(res, 403, "path not allowed", String(req.url).slice(0, 64));
    if (req.method !== "GET" && req.method !== "HEAD") return refuse(res, 405, "method not allowed", req.method || "");
    let sock;
    try { sock = await connectPinned(); }
    catch (e) { return fail(res, e); }
    const up = http.request({ createConnection: () => sock, method: req.method, path: req.url, headers: { host: hostHeader, accept: req.headers.accept || "*/*", "user-agent": "vyre-wink-shim" } }, ur => {
      const st = ur.statusCode || 502;
      if (st >= 300 && st < 400) { ur.resume(); return refuse(res, 502, "upstream redirect refused", String(ur.headers.location || "").slice(0, 64)); }
      const h = { ...ur.headers }; delete h.connection; delete h["keep-alive"]; delete h["transfer-encoding"];
      res.writeHead(st, h); ur.pipe(res); stats.proxied++;
    });
    up.on("error", e => fail(res, e));
    up.end();
  });

  const fail = (/** @type {http.ServerResponse | net.Socket} */ out, /** @type {any} */ e) => {
    if (e && e.code !== "EPINMISMATCH") emit({ type: "upstream-error", error: String(e.message || e) });
    if (out instanceof http.ServerResponse) { if (!out.headersSent) out.writeHead(502, { connection: "close" }); out.end(); }
    else out.destroy();
  };

  server.maxHeaderSize = MAX_HEAD;
  server.headersTimeout = 15_000;
  server.on("upgrade", async (req, client, head) => {
    client.on("error", () => {});
    const p = pathOf(req.url);
    const kind = p ? UPGRADES.get(p) : undefined;
    const proto = String(req.headers.upgrade || "").toLowerCase();
    if (!p || !kind || proto !== kind) return refuse(client, 403, "upgrade not allowed", `${String(req.url).slice(0, 64)} ${proto.slice(0, 32)}`);
    if (req.method !== "GET" && req.method !== "POST") return refuse(client, 405, "method not allowed", req.method || "");
    let up;
    try { up = await connectPinned(); } catch (e) { return fail(client, e); }
    up.on("error", () => client.destroy());
    client.on("close", () => up.destroy());
    up.on("close", () => client.destroy());
    // Re-send the request line and headers with Host rewritten; the client's own are not trusted verbatim.
    const lines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${hostHeader}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], lk = k.toLowerCase();
      if (lk === "host") continue;
      if (/[\r\n]/.test(k) || /[\r\n]/.test(req.rawHeaders[i + 1])) return refuse(client, 400, "bad header", "");
      lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    // Read the upstream's answer head ourselves: only a 101 may pass; anything else (a redirect) is refused.
    let buf = Buffer.alloc(0);
    const onData = (/** @type {Buffer} */ d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) { if (buf.length > MAX_HEAD) { up.destroy(); client.destroy(); } return; }
      up.removeListener("data", onData);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, 16).toString("latin1"))?.[1] || 0);
      if (status !== 101) { emit({ type: "refused", why: "upstream did not upgrade", what: String(status) }); stats.refused++; client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"); up.destroy(); return; }
      stats.upgraded++;
      client.write(buf);
      up.pipe(client); client.pipe(up);
    };
    up.on("data", onData);
  });
  server.on("clientError", (_e, s) => { try { s.destroy(); } catch { /* gone */ } });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(opts.listenPort ?? 0, "127.0.0.1", () => resolve(undefined)); });
  const addr = /** @type {net.AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${addr.port}`, port: addr.port, stats,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
