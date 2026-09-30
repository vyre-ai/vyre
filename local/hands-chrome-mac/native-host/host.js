// @ts-check
// host: what Chrome spawns as run.vyre.chrome. It moves bytes between Chrome's stdio and the
// module's local socket and reads no frame content: both sides speak the same 4-byte-length
// framing (stdio.js), so the host only finds frame boundaries (so a reconnect never starts in the
// middle of a message) and forwards each whole frame untouched.
//
// It exits 0 when either side closes: Chrome closing the pipe means the extension went away, and
// the module closing the socket means vyred stopped, and a host with one dead end has nothing
// left to do. If the module is not there yet it says so once, in a frame of its own
// ({event:"no_module"}), and tries again no faster than every 5 s while Chrome keeps stdio open.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encode, MAX } from "./stdio.js";

export const RETRY_MS = 5000;

/**
 * Where the module listens. VYRE_CHROME_SOCK wins; otherwise <VYRE_HOME or ~/.vyre>/run/chrome.sock,
 * or a per-user named pipe on Windows (a pipe has no directory to keep private, so the user name
 * is what keeps two accounts apart).
 * @param {{ env?: Record<string, string|undefined>, platform?: string, home?: string, user?: string }} [o]
 */
export function socketPath({ env = process.env, platform = process.platform, home = os.homedir(), user } = {}) {
  if (env.VYRE_CHROME_SOCK) return env.VYRE_CHROME_SOCK;
  if (platform === "win32") return `\\\\.\\pipe\\vyre-chrome-${user || safeUser()}`;
  return path.join(env.VYRE_HOME || path.join(home, ".vyre"), "run", "chrome.sock");
}
function safeUser() { try { return os.userInfo().username; } catch { return "user"; } }

/** Splits a byte stream into whole frames by their length prefix alone; the bodies are never parsed. */
function framer() {
  let buf = Buffer.alloc(0);
  return {
    /** @param {Buffer} chunk @returns {Buffer[]} */
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      /** @type {Buffer[]} */
      const out = [];
      for (;;) {
        if (buf.length < 4) break;
        const len = buf.readUInt32LE(0);
        if (len > MAX) throw new Error(`native message too large: ${len} bytes`);
        if (buf.length < 4 + len) break;
        out.push(Buffer.from(buf.subarray(0, 4 + len)));
        buf = buf.subarray(4 + len);
      }
      return out;
    },
  };
}

/**
 * Relay until either side closes. `connect()` returns a promise of a duplex stream to the module
 * and rejects when nobody listens. Resolves 0 when done (the exit code).
 * @param {NodeJS.ReadableStream} stdin @param {NodeJS.WritableStream} stdout
 * @param {() => Promise<import("node:stream").Duplex>} connect
 * @param {{ retryMs?: number, origin?: string|null }} [opts] origin: the extension origin Chrome passed as argv[2]; the host announces it to the module in one frame of its own, so the module can tell the pinned extension from any other process that writes a hello
 * @returns {Promise<number>}
 */
export function relay(stdin, stdout, connect, { retryMs = RETRY_MS, origin = null } = {}) {
  return new Promise(resolve => {
    /** @type {import("node:stream").Duplex|null} */
    let sock = null;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    let done = false;
    let told = false;
    /** @type {Buffer|null} the first frame Chrome sent while no module was there: the extension's hello */
    let early = null;
    const fromChrome = framer();
    const fromModule = framer();

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (sock) sock.destroy();
      resolve(0);
    };
    const say = (/** @type {Buffer} */ b) => { try { stdout.write(b); } catch { finish(); } };

    const attempt = () => {
      timer = null;
      if (done) return;
      connect().then(s => {
        if (done) { s.destroy(); return; }
        sock = s;
        // The extension says hello once, when Chrome starts the host. If the module was not up
        // yet that frame had nowhere to go, so it is handed over now, unread and unchanged.
        // The host's own first word: the origin Chrome launched it for. Not authentication (any
        // process of this user could write it); it tells our extension's host from another's.
        if (origin) s.write(encode({ event: "host", origin, ppid: process.ppid }));
        if (early) { s.write(early); early = null; }
        s.on("data", d => {
          try { for (const f of fromModule.push(d)) say(f); } catch { finish(); }
        });
        s.on("error", finish);
        s.on("end", finish);
        s.on("close", finish);
      }, () => {
        if (done) return;
        // Told once per outage: a host that repeats itself every 5 s is noise in the extension.
        if (!told) { told = true; say(encode({ event: "no_module" })); }
        timer = setTimeout(attempt, retryMs);
      });
    };

    stdin.on("data", d => {
      let frames;
      try { frames = fromChrome.push(/** @type {Buffer} */ (d)); } catch { finish(); return; }
      if (sock && !sock.destroyed) for (const f of frames) sock.write(f);
      else if (!early && frames.length) early = frames[0];
    });
    stdin.on("end", finish);
    stdin.on("close", finish);
    stdin.on("error", finish);
    attempt();
  });
}

/** The real connect: a unix socket or named pipe at the module's path. @param {string} p */
export const connectTo = p => () => new Promise((resolve, reject) => {
  // A unix socket some other user made is not ours to hand the browser's frames to.
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    try { const st = fs.lstatSync(p); if (st.uid !== process.getuid()) return reject(new Error("the socket belongs to another user")); } catch { /* not there yet: connect will say so */ }
  }
  const s = net.connect(p);
  s.once("connect", () => { s.removeAllListeners("error"); resolve(s); });
  s.once("error", e => { s.destroy(); reject(e); });
});

if (isMain() && process.argv.includes("--selftest")) {
  // `vyre-chrome doctor` runs the launcher with this to prove launcher -> node -> host.js works, without connecting to anything.
  console.log(JSON.stringify({ ok: true, node: process.version, execPath: process.execPath, socket: socketPath(), pid: process.pid }));
  process.exit(0);
}
if (isMain()) {
  relay(process.stdin, process.stdout, connectTo(socketPath()), { origin: process.argv[2] || null }).then(code => process.exit(code));
}

/** Whether this file is the program being run, following symlinks (a temp dir or an install may be one). */
function isMain() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}
