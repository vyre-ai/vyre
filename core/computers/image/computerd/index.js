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
// UNVALIDATED: written by inspection, never run against a live X display or AT-SPI bus. See the
// report to the lead for what needs checking once the box is up.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { URL } from "node:url";

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
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(2000) });
    chrome = res.ok ? await res.json() : null;
  } catch { chrome = null; }
  return { ok: true, display, size, chrome };
}

async function screenshot() {
  // Reads straight off the X display; no window server extension beyond what Xvnc already is.
  return run("import", ["-window", "root", "png:-"], { binary: true, timeout: 20_000 });
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`computerd listening on :${PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
