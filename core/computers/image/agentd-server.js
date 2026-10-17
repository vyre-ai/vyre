// @ts-check
// agentd-server: the HTTP skin of agentd, inside the computer. Listens on the container's internal network only, bearer token from the
// boot file, one JSON POST per action. Every body is checked against the same ranges agentd.js plans with, and a plan runs one argv at a
// time with execFile (no shell). Used by vyred through core/computers/agentd-ctl.js.

import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { planCreate, planStartScreen, planStopScreen, planWipeHome, planRemove, execute, tolerant, RUN } from "./agentd.js";

const ACTIONS = {
  "create": planCreate, "start": planStartScreen, "stop": planStopScreen, "wipe": planWipeHome, "remove": planRemove,
};

/** @param {string[]} argv @returns {Promise<void>} */
const runArgv = argv => new Promise((resolve, reject) => {
  // Xvnc, the window manager and Chrome stay up after agentd moves on, so they are started detached and not waited for.
  const longRunning = argv.some(a => a === "Xvnc" || a === "fluxbox" || a === "chromium");
  if (longRunning) {
    const child = execFile(argv[0], argv.slice(1), { stdio: "ignore", detached: true }, () => {});
    child.unref();
    return resolve();
  }
  execFile(argv[0], argv.slice(1), { timeout: 30_000 }, err => (err ? reject(new Error(`${argv[0]} failed`)) : resolve()));
});

/** @param {{ token: string, run?: (argv: string[]) => Promise<void>, writeFile?: typeof fs.writeFileSync }} o */
export function createAgentd(o) {
  const run = o.run || runArgv;
  const write = o.writeFile || fs.writeFileSync;
  const same = (/** @type {string} */ a, /** @type {string} */ b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  return http.createServer((req, res) => {
    const send = (/** @type {number} */ code, /** @type {any} */ body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const given = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (!same(given, o.token)) return send(401, { error: { code: "denied", message: "no" } });
    const action = /^\/agents\/([a-z]+)$/.exec(String(req.url || ""))?.[1];
    if (req.method !== "POST" || !action || !(action in ACTIONS)) return send(404, { error: { code: "not_found", message: "no such action" } });
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}");
        const u = { user: String(body.user), uid: Number(body.uid), display: Number(body.display) };
        const steps = /** @type {any} */ (ACTIONS)[action](u, body.limits || {});
        if (action === "start" && typeof body.vncPassword === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.vncPassword)) {
          // vncpasswd's file format is not the plain text; the image's helper converts it (agentd-vncpass), run before Xvnc starts
          write(`${RUN}/${u.user}/vnc.plain`, body.vncPassword, { mode: 0o600 });
          steps.unshift(["agentd-vncpass", `${RUN}/${u.user}/vnc.plain`, `${RUN}/${u.user}/vnc.pass`, String(u.uid)]);
        }
        await execute(steps, run, { tolerate: tolerant });
        send(200, { ok: true });
      } catch (e) {
        send(400, { error: { code: "bad_input", message: String(/** @type {Error} */ (e).message).slice(0, 200) } });
      }
    });
  });
}
