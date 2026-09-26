#!/usr/bin/env node
// computerd: the helper inside every agent's computer, answering the routes in
// docs/work/computers.md's computerd table. No framework dependency, matching the rest of this
// codebase's style (see modules/hands-desktop/client.js, which is the other end of this pipe).
//
// Every route requires `Authorization: Bearer <COMPUTERD_TOKEN>`. The token lives in an env var
// set once by entrypoint.sh and is never echoed back, logged, or included in an error: a process
// whose whole job is running inside the box a person is watching over VNC must not be the thing
// that leaks its own front door key onto that same screen if it crashes.
//
// AT-SPI is Python's job (atspi.py, next to this file); xdotool and ImageMagick's `import` are
// shelled out to directly, since there is nothing here worth a binding for a single command each.
//
// Chrome's own debugging port (9222) is never reachable off 127.0.0.1: earlier this relayed it
// out on its own unauthenticated port, which meant full CDP access (cookies, page content,
// arbitrary JS, anything the Vault autofilled) to anything else on the internal network. Now
// computerd is the only thing that ever dials 9222, and only after the same bearer check every
// other route gets: GET /cdp/json/version proxies Chrome's own answer with its
// webSocketDebuggerUrl rewritten to point back through here, and the WebSocket upgrade at
// /cdp/... relays raw bytes to and from 127.0.0.1:9222 once its own check passes. A plain
// WebSocket cannot carry an Authorization header, so that one check reads the token from
// `?token=` on the upgrade request instead — modules/hands-chrome/cdp.js appends it, and it is
// never logged or echoed, same as everywhere else here.
//
// UNVALIDATED: written by inspection, never run against a live X display or AT-SPI bus. See the
// report to the lead for what needs checking once the box is up.

import { createServer } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { URL } from "node:url";

const CHROME = { host: "127.0.0.1", port: 9222 };

const PORT = 7000;
const TOKEN = process.env.COMPUTERD_TOKEN || "";
if (!TOKEN) {
  console.error("computerd: COMPUTERD_TOKEN is not set; refusing to start with no way to authenticate callers");
  process.exit(1);
}

const ATSPI = new URL("./atspi.py", import.meta.url).pathname;

/** Run a subprocess, collect stdout/stderr, resolve/reject on exit. Never throws synchronously. */
function run(cmd, args, { input, timeout = 15_000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", d => out.push(d));
    child.stderr.on("data", d => err.push(d));
    child.on("error", e => { clearTimeout(timer); reject(new Error(`${cmd} could not be started: ${e.message}`)); });
    child.on("close", code => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code !== 0) return reject(new Error(stderr || `${cmd} exited ${code}`));
      resolve(binary ? stdout : stdout.toString("utf8"));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Run atspi.py and parse its one line of JSON, or throw its reported error. */
async function atspi(args) {
  let text;
  try {
    text = await run("python3", [ATSPI, ...args]);
  } catch (e) {
    // atspi.py prints {"error": "..."} to stderr on a handled failure; run() already turned
    // that stderr text into the Error's message, so it reads through as-is.
    throw new Error(String(/** @type {Error} */ (e).message || e));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("the AT-SPI helper answered with something that is not JSON");
  }
}

// ---- xdotool: /input ------------------------------------------------------------------

const BUTTON = { left: "1", middle: "2", right: "3", "1": "1", "2": "2", "3": "3" };

async function doInput(body) {
  const kind = body && body.kind;
  if (kind === "click") {
    const x = Number(body.x), y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click needs numeric x and y");
    const button = BUTTON[String(body.button || "left")];
    if (!button) throw new Error(`unknown button ${JSON.stringify(body.button)}`);
    await run("xdotool", ["mousemove", "--sync", String(Math.round(x)), String(Math.round(y))]);
    await run("xdotool", ["click", button]);
    return { ok: true };
  }
  if (kind === "key") {
    const keys = String(body.keys || "");
    if (!keys) throw new Error("key needs keys");
    await run("xdotool", ["key", keys]);
    return { ok: true };
  }
  if (kind === "type") {
    const text = String(body.text ?? "");
    // xdotool type reads argv, not stdin; -- stops it from treating a leading "-" in the text as
    // an option of its own.
    await run("xdotool", ["type", "--clearmodifiers", "--", text]);
    return { ok: true };
  }
  throw new Error(`unknown input kind ${JSON.stringify(kind)}`);
}

// ---- routes ---------------------------------------------------------------------------

/** @param {import("node:http").IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > 1_000_000) { req.destroy(); reject(new Error("request body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try { resolve(JSON.parse(text)); }
      catch { reject(new Error("body is not JSON")); }
    });
    req.on("error", reject);
  });
}

async function health() {
  let display = process.env.DISPLAY || "";
  let size = null;
  try {
    const info = await run("xdotool", ["getdisplaygeometry"]);
    const [w, h] = info.trim().split(/\s+/).map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) size = { w, h };
  } catch { /* leave size null; /health still answers */ }
  let chrome = null;
  try {
    const res = await fetch(`http://${CHROME.host}:${CHROME.port}/json/version`, { signal: AbortSignal.timeout(2000) });
    chrome = res.ok ? await res.json() : null;
  } catch { chrome = null; }
  return { ok: true, display, size, chrome };
}

async function screenshot() {
  // Reads straight off the X display; no window server extension beyond what Xvnc already is.
  return run("import", ["-window", "root", "png:-"], { binary: true, timeout: 20_000 });
}

/**
 * Chrome's own /json/version, fetched over loopback and handed back with its
 * webSocketDebuggerUrl rewritten to point through this proxy instead of at 127.0.0.1:9222 —
 * `host` is whatever the caller used to reach computerd (req.headers.host), so the URL it gets
 * back is exactly the address it can actually dial next.
 * @param {string} host
 */
async function cdpVersion(host) {
  let res;
  try { res = await fetch(`http://${CHROME.host}:${CHROME.port}/json/version`, { signal: AbortSignal.timeout(5000) }); }
  catch (e) { throw new Error(`chromium is not answering on its debugging port: ${/** @type {Error} */ (e).message}`); }
  if (!res.ok) throw new Error(`chromium's /json/version answered HTTP ${res.status}`);
  const info = await res.json();
  if (info && typeof info.webSocketDebuggerUrl === "string") {
    // ws://127.0.0.1:9222/devtools/browser/<id> -> ws://<host, from the caller's own request>/cdp/devtools/browser/<id>
    info.webSocketDebuggerUrl = info.webSocketDebuggerUrl.replace(/^wss?:\/\/[^/]+/, `ws://${host}/cdp`);
  }
  return info;
}

/**
 * Proxy a CDP WebSocket upgrade to Chrome's loopback debugging port, once the token in the
 * request's own query string checks out (a plain WebSocket cannot send an Authorization header).
 * Nothing here parses CDP itself: once the token is checked, it is a dumb authenticated pipe.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:net").Socket} socket
 * @param {Buffer} head
 */
function proxyCdpUpgrade(req, socket, head) {
  const url = new URL(req.url || "/", "http://computerd");
  const token = url.searchParams.get("token") || "";
  if (token !== TOKEN) { socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n"); return; }
  if (!url.pathname.startsWith("/cdp/")) { socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n"); return; }
  const targetPath = url.pathname.slice("/cdp".length);

  const upstream = connect(CHROME.port, CHROME.host);
  upstream.on("error", () => { try { socket.destroy(); } catch {} });
  socket.on("error", () => { try { upstream.destroy(); } catch {} });
  upstream.on("connect", () => {
    // Chrome's own handshake, rebuilt from the browser's request rather than replayed verbatim:
    // the path loses its /cdp prefix and the token never leaves computerd, and Host must name
    // Chrome's own loopback address or its DevTools host check refuses the upgrade.
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (/^host$/i.test(name)) continue;
      headers.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    headers.push(`Host: ${CHROME.host}:${CHROME.port}`);
    upstream.write(`GET ${targetPath} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}

const server = createServer(async (req, res) => {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const sendBinary = (status, buf, contentType) => {
    res.writeHead(status, { "content-type": contentType });
    res.end(buf);
  };
  try {
    const auth = req.headers["authorization"] || "";
    const ok = typeof auth === "string" && auth === `Bearer ${TOKEN}`;
    if (!ok) return send(401, { error: { message: "missing or wrong bearer token" } });

    const url = new URL(req.url || "/", "http://computerd");
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/health") {
      return send(200, await health());
    }
    if (req.method === "GET" && pathname === "/apps") {
      return send(200, await atspi(["apps"]));
    }
    if (req.method === "GET" && pathname === "/tree") {
      const app = url.searchParams.get("app") || "";
      const args = app ? ["tree", "--app", app] : ["tree"];
      return send(200, await atspi(args));
    }
    if (req.method === "GET" && pathname === "/screenshot") {
      return sendBinary(200, await screenshot(), "image/png");
    }
    if (req.method === "GET" && pathname === "/cdp/json/version") {
      return send(200, await cdpVersion(String(req.headers.host || `127.0.0.1:${PORT}`)));
    }
    if (req.method === "POST" && pathname === "/act") {
      const body = await readBody(req);
      if (!body || typeof body.path !== "string" || typeof body.action !== "string") {
        return send(400, { error: { message: "act needs {path, action, value?}" } });
      }
      const args = body.app
        ? ["act", body.path, body.action, ...(body.value !== undefined ? [String(body.value)] : []), "--app", body.app]
        : ["act", body.path, body.action, ...(body.value !== undefined ? [String(body.value)] : [])];
      return send(200, await atspi(args));
    }
    if (req.method === "POST" && pathname === "/input") {
      const body = await readBody(req);
      return send(200, await doInput(body));
    }
    return send(404, { error: { message: `no such route: ${req.method} ${pathname}` } });
  } catch (e) {
    const message = String(/** @type {Error} */ (e).message || e).replace(new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[token]");
    send(500, { error: { message } });
  }
});

// CDP's WebSocket upgrade never reaches the request handler above (Node routes it here
// instead), so it gets its own auth check: proxyCdpUpgrade reads the token from the query
// string, since a plain WebSocket cannot set a header.
server.on("upgrade", (req, socket, head) => proxyCdpUpgrade(req, socket, head));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`computerd listening on :${PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
