// @ts-check
// agentd-server: the HTTP skin of agentd, inside the computer. Listens on the container's internal network only, bearer token from the
// boot file, one JSON POST per action. Every body is checked against the same ranges agentd.js plans with, and a plan runs one argv at a
// time with execFile (no shell). Used by vyred through core/computers/agentd-ctl.js.

import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { Tickets, SESSION_RE } from "./agentd-relay.js";
import { planTerminals, parseTerminals, planCreate, planStartScreen, planStopScreen, planWipeHome, planRemove, asAgent, execute, tolerant, RUN } from "./agentd.js";

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

/** @param {{ token: string, run?: (argv: string[]) => Promise<void>, out?: (argv: string[]) => Promise<string>, tickets?: Tickets }} o */
export function createAgentd(o) {
  const run = o.run || runArgv;
  const tickets = o.tickets || new Tickets();
  const out = o.out || runOut;
  const same = (/** @type {string} */ a, /** @type {string} */ b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  return http.createServer((req, res) => {
    const send = (/** @type {number} */ code, /** @type {any} */ body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const given = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (!same(given, o.token)) return send(401, { error: { code: "denied", message: "no" } });
    const action = /^\/agents\/([a-z]+)$/.exec(String(req.url || ""))?.[1];
    if (req.method !== "POST" || !action || !(action in ACTIONS || action === "ticket" || action === "terminals")) return send(404, { error: { code: "not_found", message: "no such action" } });
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}");
        const u = { user: String(body.user), uid: Number(body.uid), display: Number(body.display) };
        if (action === "ticket") {
          // a viewer's one-use way to this agent's screen: checked as an agent triple like every action, then held for the relay
          planCreate(u);
          const session = body.session === undefined || body.session === null ? null : String(body.session);
          if (session !== null && !SESSION_RE.test(session)) throw new Error("not a terminal name");
          tickets.add(String(body.ticket), u, session);
          return send(200, { ok: true });
        }
        if (action === "terminals") return send(200, { sessions: parseTerminals(await out(planTerminals(u))) });
        const steps = /** @type {any} */ (ACTIONS)[action](u, body.limits || {});
        if (action === "start" && typeof body.vncPassword === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.vncPassword)) {
          // The password goes to a helper that runs AS the agent and reads it from standard input: never an argument, never a plain file.
          steps.unshift(Object.assign([...asAgent(u, body.limits || {}), "/usr/local/bin/agentd-vncpass", `${RUN}/${u.user}/vnc.pass`], { input: body.vncPassword }));
        }
        await execute(steps, run, { tolerate: tolerant });
        send(200, { ok: true });
      } catch (e) {
        send(400, { error: { code: "bad_input", message: String(/** @type {Error} */ (e).message).slice(0, 200) } });
      }
    });
  });
}
