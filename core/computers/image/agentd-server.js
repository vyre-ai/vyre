// @ts-check
// agentd-server: the HTTP skin of agentd, inside the computer. Listens on the container's internal network only, bearer token from the
// boot file, one JSON POST per action. Every body is checked against the same ranges agentd.js plans with, and a plan runs one argv at a
// time with execFile (no shell). Used by vyred through core/computers/agentd-ctl.js.

import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { Tickets, SESSION_RE } from "./agentd-relay.js";
import { planTerminals, parseTerminals, planCreate, planStartScreen, planStopScreen, planWipeHome, planRemove, planExec, planShot, SHOT, EXEC_LIMITS, asBrowser, browserOf, execute, tolerant } from "./agentd.js";

const ACTIONS = {
  "create": planCreate, "start": planStartScreen, "stop": planStopScreen, "wipe": planWipeHome, "remove": planRemove,
};

/** @param {string[]} argv @returns {Promise<void>} */
const runArgv = argv => new Promise((resolve, reject) => {
  // agentd's own environment never reaches a child: every step carries the environment it needs (asAgent), the rest is empty.
  const opts = { env: {}, timeout: 30_000 };
  const input = /** @type {any} */ (argv).input;
  if (/** @type {any} */ (argv).detach === true) {
    // a screen, a window manager, Chrome: started detached and not waited for
    const child = execFile(argv[0], argv.slice(1), { env: {} }, () => {});
    child.unref();
    return resolve();
  }
  const child = execFile(argv[0], argv.slice(1), opts, err => (err ? reject(new Error(`${argv[0]} failed`)) : resolve()));
  if (typeof input === "string") child.stdin?.end(input);
});

/** @param {string[]} argv @returns {Promise<string>} what the command printed; empty when it fails (tmux with no server exits 1) */
const runOut = argv => new Promise(resolve => {
  execFile(argv[0], argv.slice(1), { env: {}, timeout: 10_000, maxBuffer: 64 * 1024 }, (_err, stdout) => resolve(String(stdout || "")));
});

/**
 * Run one command and keep what it printed, within the caps. The child gets an empty environment of its own (planExec's argv carries the one it should have), the stdin it was given, and a time limit.
 * @param {string[]} argv @param {{ stdin?: string, timeoutMs: number }} o
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string, truncated: boolean }>}
 */
const runExec = (argv, o) => new Promise(resolve => {
  const child = execFile(argv[0], argv.slice(1), { env: {}, timeout: o.timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "buffer" }, (err, so, se) => {
    const cut = (/** @type {Buffer} */ b, /** @type {number} */ n) => ({ text: b.subarray(0, n).toString("utf8"), cut: b.length > n });
    const out = cut(so || Buffer.alloc(0), EXEC_LIMITS.stdoutBytes), er = cut(se || Buffer.alloc(0), EXEC_LIMITS.stderrBytes);
    const e = /** @type {any} */ (err);
    resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, signal: e && e.killed ? "SIGKILL" : (e && e.signal) || null, stdout: out.text, stderr: er.text, truncated: out.cut || er.cut });
  });
  if (child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(typeof o.stdin === "string" ? o.stdin : ""); }
});

/**
 * Run one command and keep what it printed as bytes (a picture), capped. A command that fails or prints more than the cap is an error, never a partial picture.
 * @param {string[]} argv @returns {Promise<Buffer>}
 */
const runBytes = argv => new Promise((resolve, reject) => {
  execFile(argv[0], argv.slice(1), { env: {}, timeout: 10_000, maxBuffer: SHOT.maxBytes + 1, encoding: "buffer", killSignal: "SIGKILL" }, (err, so) => {
    if (err || !so || !so.length) return reject(new Error("no picture of that screen"));
    if (so.length > SHOT.maxBytes) return reject(new Error("the picture is too large"));
    resolve(Buffer.from(so));
  });
});

/** @param {{ token: string, run?: (argv: string[]) => Promise<void>, out?: (argv: string[]) => Promise<string>, tickets?: Tickets, exec?: typeof runExec, shot?: typeof runBytes }} o */
export function createAgentd(o) {
  const run = o.run || runArgv;
  const tickets = o.tickets || new Tickets();
  const out = o.out || runOut;
  const exec = o.exec || runExec;
  const shot = o.shot || runBytes;
  const same = (/** @type {string} */ a, /** @type {string} */ b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  return http.createServer((req, res) => {
    const send = (/** @type {number} */ code, /** @type {any} */ body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const given = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (!same(given, o.token)) return send(401, { error: { code: "denied", message: "no" } });
    const action = /^\/agents\/([a-z]+)$/.exec(String(req.url || ""))?.[1];
    if (req.method !== "POST" || !action || !(action in ACTIONS || action === "ticket" || action === "terminals" || action === "exec" || action === "shot")) return send(404, { error: { code: "not_found", message: "no such action" } });
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 15_000) req.destroy(); });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}");
        const u = { user: String(body.user), uid: Number(body.uid), display: Number(body.display) };
        if (action === "ticket") {
          // a viewer's one-use way to this agent's screen: checked as an agent triple like every action, then held for the relay
          planCreate(u);
          const session = body.session === undefined || body.session === null ? null : String(body.session);
          if (session !== null && !SESSION_RE.test(session)) throw new Error("not a terminal name");
          if (body.kind !== undefined && body.kind !== "cdp" && body.kind !== "run") throw new Error("not a ticket kind");
          if (body.kind === "cdp" && session !== null) throw new Error("a debugging ticket names no terminal");
          if (body.kind === "run") {
            if (session !== null) throw new Error("a run ticket names no terminal");
            tickets.add(String(body.ticket), u, "run", null, { argv: body.argv, cwd: body.cwd, env: body.env });
            return send(200, { ok: true });
          }
          tickets.add(String(body.ticket), u, session !== null ? "term" : body.kind === "cdp" ? "cdp" : "vnc", session);
          return send(200, { ok: true });
        }
        if (action === "exec") {
          const stdin = body.stdin === undefined || body.stdin === null ? "" : body.stdin;
          if (typeof stdin !== "string" || Buffer.byteLength(stdin) > EXEC_LIMITS.stdinBytes) throw new Error("the input is too large");
          const t = body.timeoutMs === undefined ? EXEC_LIMITS.defaultTimeoutMs : Number(body.timeoutMs);
          if (!Number.isInteger(t) || t < 100 || t > EXEC_LIMITS.timeoutMs) throw new Error("the time limit is 100 ms to 25 seconds");
          const argv = planExec(u, body, body.limits || {});
          return send(200, await exec(argv, { stdin, timeoutMs: t }));
        }
        if (action === "shot") { const jpeg = await shot(planShot(u)); return send(200, { mime: "image/jpeg", width: SHOT.width, height: SHOT.height, jpeg: jpeg.toString("base64") }); }
        if (action === "terminals") return send(200, { sessions: parseTerminals(await out(planTerminals(u))) });
        const steps = /** @type {any} */ (ACTIONS)[action](u, body.limits || {});
        if (action === "start" && typeof body.vncPassword === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.vncPassword)) {
          // The password goes to a helper that runs AS the browser uid (the screen's owner) and reads it from standard input: never an argument, never a plain file.
          steps.unshift(Object.assign([...asBrowser(u, body.limits || {}), "/usr/local/bin/agentd-vncpass", browserOf(u).vncPass], { input: body.vncPassword }));
        }
        await execute(steps, run, { tolerate: tolerant });
        send(200, { ok: true });
      } catch (e) {
        send(400, { error: { code: "bad_input", message: String(/** @type {Error} */ (e).message).slice(0, 200) } });
      }
    });
  });
}
