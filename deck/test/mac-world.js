// @ts-check
// A throwaway world for looking at the Deck on a box with a paired Mac: one node process runs a
// box vyred ("harlow-box") and a Mac vyred ("alex-mac") in temp homes under the test SCRATCH
// folder, paired through the link's seams and a simulated tailnet listener (test/link-harness.js,
// the same pairing the link tests use). The fictional corpus is split between them: three
// sessions on the Mac, the rest on the box. A box project, Harlow Legal, lives in the box's
// harlow-site folder. The box's Deck is served on 127.0.0.1:<port> through a plain proxy to the
// box's unix socket, as deck/test/world.js does, so the Deck's caller is the person's.
//
// Two control routes on the proxy take the Mac off the simulated tailnet and back:
//   POST /__mac/off   the tailnet listener stops; link.macs says the Mac is offline a few seconds later
//   POST /__mac/on    it listens again; the Mac's next heartbeat (1 s) starts its serve loop again
//
// A test helper, not part of the product. Never touches ~/.vyre, never the real Tailscale, no
// network beyond 127.0.0.1.
//
//   node deck/test/mac-world.js [port]      prints the URL, runs until Ctrl-C, then removes the homes

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Before the harness loads: no dialog, and a sample tailnet (fake-tailscale.js), never the real one.
process.env.VYRE_NO_DIALOGS = "1";
process.env.NO_COLOR = "1";
process.env.VYRE_TAILSCALE_BIN = path.join(REPO, "deck", "test", "fake-tailscale.js");

const { SESSIONS, HOME } = await import("../../test/fixtures/corpus.js");
const { SCRATCH } = await import("../../test/scratch.mjs");
const { pair, until } = await import("../../test/link-harness.js");
const { socketPath } = await import("../../core/config/index.js");

const PORT = Number(process.argv[2] || 4748);
const log = (/** @type {string} */ m) => console.log(`mac world: ${m}`);

// The pairing harness takes a test context; a script gives it the two things it uses.
/** @type {(() => any)[]} */ const cleanups = [];
const t = { name: "mac-world", fullName: "deck/test/mac-world.js", after: (/** @type {() => any} */ fn) => { cleanups.push(fn); } };

// Session folders, so the box project has a home and each session a real cwd.
const base = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vy-macw-")));
const on = (/** @type {string} */ side, /** @type {any} */ s) => ({ ...s, cwd: s.cwd.replace(HOME, path.join(base, side, "alex")) });
// The Mac: Harlow intake, Northwind invoices, weekly planning. The box: the Harlow site rebuild
// (with its subagent) and the headless Northwind summary.
const MAC_IDS = ["11111111-aaaa-4000-8000-000000000002", "11111111-aaaa-4000-8000-000000000003", "11111111-aaaa-4000-8000-000000000004"];
const macSessions = SESSIONS.filter(s => MAC_IDS.includes(s.id)).map(s => on("mac", s));
const boxSessions = SESSIONS.filter(s => !MAC_IDS.includes(s.id)).map(s => on("box", s));
for (const s of [...macSessions, ...boxSessions]) fs.mkdirSync(s.cwd, { recursive: true });

let world;
try {
  world = await pair(t, { hold: 2000, heartbeat: 1000, boxName: "harlow-box", macHost: "alex-mac",
    macTranscripts: macSessions, boxTranscripts: boxSessions,
    boxConfig: { projectsDir: path.join(base, "box", "projects"), roots: [path.join(base, "box", "alex", "Work")] } });
} catch (e) { await down(); throw e; }
const { boxCall } = world;

// Both indexes, read through the box as the person does.
await until(async () => {
  const r = await boxCall("recall.sessions", { limit: 50 }, "deck");
  const rows = Array.isArray(r.data) ? r.data : [];
  return rows.some(x => x.source === "mac") && rows.some(x => x.source === "box");
}, 30_000).catch(() => log("warning: the federated session list did not show both machines within 30 s"));

const harlowHome = boxSessions.find(s => s.id.endsWith("0001") && !s.parent)?.cwd;
const made = await boxCall("projects.create", { name: "Harlow Legal", home: harlowHome, people: [{ name: "Dana Reyes", email: "dana@harlowlegal.com" }] });
if (made.error) log(`projects.create: ${made.error.message}`);

const sock = socketPath(world.boxRoot);
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && (req.url === "/__mac/off" || req.url === "/__mac/on")) {
    try {
      if (req.url === "/__mac/off") await world.stopTailnet(); else await world.startTailnet();
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { mac: req.url.endsWith("on") ? "on" : "off" } }));
    } catch (e) { res.writeHead(500); res.end(String(/** @type {Error} */ (e).message)); }
    return;
  }
  const up = http.request({ socketPath: sock, path: req.url, method: req.method, headers: req.headers }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", e => { res.writeHead(502); res.end(String(e.message)); });
  req.pipe(up);
});
server.listen(PORT, "127.0.0.1", () => log(`http://127.0.0.1:${PORT}/  (box harlow-box, Mac alex-mac, homes under ${base})`));

// Cleanups in reverse: stop the Mac, then the tailnet and the box, then the temp homes.
let downing = false;
async function down() {
  if (downing) return;
  downing = true;
  for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { console.error(`mac world: cleanup: ${/** @type {Error} */ (e).message}`); } }
  fs.rmSync(base, { recursive: true, force: true });
}
process.on("exit", () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
const quit = async () => { server.close(); server.closeAllConnections(); await down(); process.exit(0); };
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
