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
// Chrome is computerd's own child, started with --remote-debugging-pipe: it has no debugging
// port at all, so nothing else on the computer (the agent's own terminal included) can reach it
// and step around the token and the shield. computerd owns that one pipe and shares it between
// its clients through cdpmux.js, which gives every client a browser session of its own (so what
// one client switches on, Fetch interception or a trace, never outlives it or reaches another),
// keeps each client's ids and sessions apart, and refuses Browser.close. GET /cdp/json/version answers in Chrome's own /json/version shape
// with a webSocketDebuggerUrl pointing back here, and the WebSocket upgrade at
// /cdp/devtools/browser/<id> is the only way in. A plain WebSocket cannot carry an Authorization
// header, so that one check reads the token from `?token=` on the upgrade request instead:
// modules/hands-chrome/cdp.js appends it, and it is never logged or echoed, same as everywhere
// else here. Chrome is restarted if it exits (1 s, doubling to 30 s at most), and every call
// still waiting on it is answered with an error.
//
// Two kinds of client. COMPUTERD_TOKEN is the agent's. While a person signs in (the shield,
// POST /shield), the agent's clients are cut and new ones get 423; the shield may also carry a
// fill token, which alone is accepted as a "fill" client (the Vault filling the sign-in form)
// on the upgrade and on /cdp/json/version, and nowhere else. Lowering the shield forgets it and
// cuts those clients too.
//
// UNVALIDATED: written by inspection, never run against a live X display or AT-SPI bus. See the
// report to the lead for what needs checking once the box is up.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { createFs } from "./fs.js";
import { CdpMux } from "./cdpmux.js";
import { acceptKey, encodeFrame, FrameParser } from "./ws.js";

const PORT = Number(process.env.COMPUTERD_PORT || 7000);
const TOKEN = process.env.COMPUTERD_TOKEN || "";
if (!TOKEN) {
  console.error("computerd: COMPUTERD_TOKEN is not set; refusing to start with no way to authenticate callers");
  process.exit(1);
}

const ATSPI = new URL("./atspi.py", import.meta.url).pathname;

// ---- Chrome: its flags, moved here from entrypoint.sh -------------------------------------
const HOME = process.env.HOME || "/home/agent";
const CHROME_BIN = process.env.CHROME_BIN || "chromium";
// The image sets both (the browser's own folder, outside the agent's home); the defaults are
// for running computerd by hand.
const CHROME_PROFILE = process.env.CHROME_PROFILE || path.join(HOME, ".chromium");
const CHROME_LOG = process.env.CHROME_LOG || path.join(HOME, ".chromium.log");
const SCREEN = /^[0-9]+x[0-9]+$/.test(process.env.SCREEN || "") ? String(process.env.SCREEN) : "1440x900";
// The few sites that go out through the user's Mac (config glass.egress, core/computers/egress.js):
// vyred passes the proxy script as a data: URL only when the setting is on and lists a site.
// Checked against that exact shape, so nothing else ever reaches Chrome's command line through it.
// WebRTC is kept off UDP that bypasses the proxy, or a listed site could still learn this box's
// own address from a STUN reply.
const PAC = process.env.VYRE_PROXY_PAC || "";
const PAC_SHAPE = /^data:application\/x-ns-proxy-autoconfig;base64,[A-Za-z0-9+\/]+=*$/;
if (PAC && !PAC_SHAPE.test(PAC)) {
  console.error("computerd: VYRE_PROXY_PAC is not a PAC data: URL; refusing to start Chrome without the sites it lists");
  process.exit(1);
}
/** The id in the one browser endpoint this computerd serves: /cdp/devtools/browser/<id>. */
const BROWSER_ID = crypto.randomUUID();
const BROWSER_PATH = `/cdp/devtools/browser/${BROWSER_ID}`;

// Glass's file routes (fs.js), and the shield: while a person signs in, the routes that see or
// touch the screen answer 423 (ADR 0005, decision 3). In memory, so a restart starts unshielded.
const files = createFs();
let shielded = false;
/** Set only while shielded, by POST /shield {on: true, fill_token}; see the header. */
let fillToken = "";
const SHIELDED_ROUTES = new Set(["GET /tree", "GET /screenshot", "POST /act", "POST /input"]);

// node:child_process.spawn() inherits the whole environment by default, VNC_PASSWORD and
// COMPUTERD_TOKEN included, and every one of xdotool/import/atspi.py is a child of this process.
// None of them needs either secret; a fixed allowlist means a variable this file has never heard
// of does not quietly start reaching every command it shells out to (security, 26 Sep - this does
// not close the exec residual `run.vyre.computers`'s labels still leave open, since an exec'd
// shell can read PID 1's own real environment directly from /proc/1/environ regardless of what
// any child of computerd gets; it closes the separate, easier channel of computerd's own spawned
// children leaking the same values if one of them ever echoes or crash-dumps its environment).
const CHILD_ENV_ALLOW = ["PATH", "HOME", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "LANG", "LC_ALL"];
const childEnv = (allow = CHILD_ENV_ALLOW) => Object.fromEntries(allow.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
// Chrome gets the same allowlist plus what the entrypoint exports for accessibility (AT-SPI
// only sees Chromium's tree with these) and the session bus's pid. Before computerd started it,
// Chrome inherited the entrypoint's whole environment, the VNC password and this token included.
const CHROME_ENV_ALLOW = [...CHILD_ENV_ALLOW, "DBUS_SESSION_BUS_PID", "GTK_MODULES", "NO_AT_BRIDGE", "QT_ACCESSIBILITY", "XAUTHORITY", "TZ", "LANGUAGE", "USER"];

/** Constant-time token comparison; hashing first hides the length too. */
function sameToken(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Run a subprocess, collect stdout/stderr, resolve/reject on exit. Never throws synchronously. */
function run(cmd, args, { input, timeout = 15_000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
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

// ---- Chrome, over its pipe -------------------------------------------------------------

/** Logs name methods and count things; cdpmux never hands this a message's contents. */
const mux = new CdpMux({ log: line => console.log(line) });
/** @type {import("node:child_process").ChildProcess|null} */
let chrome = null;
let stopping = false;
let backoff = 1000;
let firstLaunch = true;
/** @type {NodeJS.Timeout|null} */
let restartTimer = null;

function chromeArgs() {
  const [w, h] = SCREEN.split("x");
  return [
    "--no-sandbox",
    // --test-type keeps Chromium from drawing its --no-sandbox warning bar into the Glass stream.
    "--test-type",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--force-renderer-accessibility",
    // Nothing loads into this browser but the pages the agent opens.
    "--disable-extensions",
    // No keyring in here; say so rather than let Chrome guess (ADR 0005: cookies are obfuscated,
    // not encrypted, and the volume holding them is what needs protecting).
    "--password-store=basic",
    // CDP on fds 3 and 4, no port: see the header.
    "--remote-debugging-pipe",
    `--user-data-dir=${CHROME_PROFILE}`,
    `--window-size=${w},${h}`,
    "--start-maximized",
    ...(PAC ? [`--proxy-pac-url=${PAC}`, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] : []),
    "about:blank",
  ];
}

function launchChrome() {
  restartTimer = null;
  if (stopping) return;
  // The profile lives on the home volume; a container that was killed (or a Chrome that crashed)
  // leaves its Singleton locks behind, and the next one then refuses to start with "profile in use".
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.unlinkSync(path.join(CHROME_PROFILE, f)); } catch {}
  }
  /** @type {number|"ignore"} */
  let logfd = "ignore";
  try { logfd = fs.openSync(CHROME_LOG, firstLaunch ? "w" : "a"); } catch {}
  firstLaunch = false;
  const started = Date.now();
  let done = false;
  /** @param {string} why */
  const gone = why => {
    if (done) return;
    done = true;
    chrome = null;
    mux.detach(`Chrome ${why}`);
    if (stopping) return;
    if (Date.now() - started > 60_000) backoff = 1000;
    console.error(`computerd: chromium ${why}; starting it again in ${backoff / 1000} s`);
    restartTimer = setTimeout(launchChrome, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  /** @type {import("node:child_process").ChildProcess} */
  let child;
  try {
    child = spawn(CHROME_BIN, chromeArgs(), { stdio: ["ignore", logfd, logfd, "pipe", "pipe"], env: childEnv(CHROME_ENV_ALLOW) });
  } catch (e) {
    if (typeof logfd === "number") try { fs.closeSync(logfd); } catch {}
    gone(`could not be started: ${/** @type {Error} */ (e).message}`);
    return;
  }
  if (typeof logfd === "number") try { fs.closeSync(logfd); } catch {}
  chrome = child;
  child.on("error", e => gone(`could not be started: ${/** @type {any} */ (e).code || e.message}`));
  child.on("exit", (code, signal) => gone(signal ? `was stopped by ${signal}` : `exited ${code}`));
  const toChrome = /** @type {import("node:stream").Writable} */ (child.stdio[3]);
  const fromChrome = /** @type {import("node:stream").Readable} */ (child.stdio[4]);
  if (toChrome && fromChrome) mux.attach(toChrome, fromChrome);
  console.log("computerd: chromium started");
}

/** Chrome's /json/version shape, from Browser.getVersion over the pipe. @param {number} timeout */
async function chromeVersion(timeout) {
  const v = await mux.call("Browser.getVersion", {}, undefined, timeout);
  return {
    "Browser": v.product,
    "Protocol-Version": v.protocolVersion,
    "User-Agent": v.userAgent,
    "V8-Version": v.jsVersion,
    "WebKit-Version": v.revision,
  };
}

/**
 * GET /cdp/json/version: Chrome's own answer, with a webSocketDebuggerUrl that points back
 * through here. `host` is whatever the caller used to reach computerd (req.headers.host), so the
 * URL it gets back is exactly the address it can dial next.
 * @param {string} host
 */
async function cdpVersion(host) {
  if (!mux.up) throw Object.assign(new Error("chromium is not running (it is being started again)"), { status: 503 });
  let info;
  try { info = await chromeVersion(5000); }
  catch (e) { throw Object.assign(new Error(`chromium did not answer: ${/** @type {Error} */ (e).message}`), { status: 503 }); }
  return { ...info, webSocketDebuggerUrl: `ws://${host}${BROWSER_PATH}` };
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
  try { chrome = mux.up ? await chromeVersion(2000) : null; } catch { chrome = null; }
  return { ok: true, display, size, chrome };
}

async function screenshot() {
  // Reads straight off the X display; no window server extension beyond what Xvnc already is.
  return run("import", ["-window", "root", "png:-"], { binary: true, timeout: 20_000 });
}

/**
 * The CDP WebSocket: checked (token from `?token=`, path, shield), handshaken here, and handed to
 * the mux as one client. Nothing is relayed anywhere; there is no port to relay to.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:stream").Duplex} socket
 * @param {Buffer} head
 */
function cdpUpgrade(req, socket, head) {
  socket.on("error", () => {});
  const refuse = status => { try { socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); } catch {} };
  let url;
  try { url = new URL(req.url || "/", "http://computerd"); } catch { return refuse("400 Bad Request"); }
  const token = url.searchParams.get("token") || "";
  const kind = sameToken(token, TOKEN) ? "agent" : (fillToken && sameToken(token, fillToken)) ? "fill" : null;
  if (!kind) return refuse("401 Unauthorized");
  if (url.pathname !== BROWSER_PATH) return refuse("404 Not Found");
  // While a person signs in, the agent does not attach to Chrome: a CDP session could read the form.
  if (kind === "agent" && shielded) return refuse("423 Locked");
  const key = req.headers["sec-websocket-key"];
  if (String(req.headers.upgrade || "").toLowerCase() !== "websocket" || typeof key !== "string" || !key) return refuse("400 Bad Request");
  if (!mux.up) return refuse("503 Service Unavailable");

  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  if (typeof (/** @type {any} */ (socket)).setNoDelay === "function") /** @type {any} */ (socket).setNoDelay(true);
  let open = true;
  const transport = {
    /** @param {string} text */
    send(text) { if (open) socket.write(encodeFrame(Buffer.from(text, "utf8"), 0x1)); },
    close() {
      if (!open) return;
      open = false;
      // 1001, going away; then make sure the socket really goes even if the client never answers.
      try { socket.end(encodeFrame(Buffer.from([0x03, 0xe9]), 0x8)); } catch {}
      setTimeout(() => socket.destroy(), 1000).unref();
    },
  };
  const client = mux.addClient(kind, transport);
  const parser = new FrameParser();
  /** @param {Buffer} chunk */
  const onData = chunk => {
    let msgs;
    try { msgs = parser.push(chunk); } catch { open = false; socket.destroy(); return; }
    for (const m of msgs) {
      if ("control" in m) {
        if (m.control === "ping" && open) socket.write(encodeFrame(m.payload, 0xa));
        else if (m.control === "close") transport.close();
        continue;
      }
      client.receive(m.message.toString("utf8"));
    }
  };
  socket.on("data", onData);
  socket.on("close", () => { open = false; client.leave(); });
  if (head && head.length) onData(head);
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
    const url = new URL(req.url || "/", "http://computerd");
    const { pathname } = url;
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    const isVersion = req.method === "GET" && pathname === "/cdp/json/version";
    // The fill token opens /cdp/json/version (and the upgrade) and nothing else.
    const kind = sameToken(bearer, TOKEN) ? "agent" : (isVersion && fillToken && sameToken(bearer, fillToken)) ? "fill" : null;
    if (!kind) return send(401, { error: { message: "missing or wrong bearer token" } });

    if (pathname.startsWith("/fs/")) return files(req, res, url);
    if (req.method === "POST" && pathname === "/shield") {
      const body = await readBody(req);
      const on = Boolean(body && body.on === true);
      const ft = body ? body.fill_token : undefined;
      if (ft !== undefined && ft !== null) {
        if (!on) return send(400, { error: { message: "fill_token is only accepted with on: true" } });
        if (typeof ft !== "string" || ft.length < 32) return send(400, { error: { message: "fill_token must be a string of at least 32 characters" } });
        if (sameToken(ft, TOKEN)) return send(400, { error: { message: "fill_token must differ from computerd's own token" } });
      }
      shielded = on;
      if (on) {
        mux.closeKind("agent");
        if (typeof ft === "string") {
          // A new fill token retires whatever the old one let in.
          if (fillToken && !sameToken(ft, fillToken)) mux.closeKind("fill");
          fillToken = ft;
        }
      } else {
        fillToken = "";
        mux.closeKind("fill");
      }
      return send(200, { shielded });
    }
    if (shielded && SHIELDED_ROUTES.has(`${req.method} ${pathname}`)) return send(423, { error: { code: "shielded", message: "a person is signing in on this computer" } });

    if (isVersion) {
      if (kind === "agent" && shielded) return send(423, { error: { code: "shielded", message: "a person is signing in on this computer" } });
      return send(200, await cdpVersion(String(req.headers.host || `127.0.0.1:${PORT}`)));
    }
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
    let message = String(/** @type {Error} */ (e).message || e);
    for (const secret of [TOKEN, fillToken]) if (secret) message = message.split(secret).join("[token]");
    const status = Number(/** @type {any} */ (e).status) || 500;
    send(status, { error: { message } });
  }
});

// CDP's WebSocket upgrade never reaches the request handler above (Node routes it here
// instead), so it gets its own auth check: cdpUpgrade reads the token from the query string,
// since a plain WebSocket cannot set a header.
server.on("upgrade", (req, socket, head) => cdpUpgrade(req, socket, head));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`computerd listening on :${PORT}`);
});

launchChrome();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    mux.closeAll();
    if (chrome) { try { chrome.kill("SIGTERM"); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
