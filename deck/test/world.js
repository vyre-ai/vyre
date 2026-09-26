// @ts-check
// A throwaway world for looking at the Deck: a temp VYRE_HOME under /tmp/vy-deck-*, the fictional
// corpus written as real transcripts, a real vyred, two projects made with `vyre new`, and a
// plain HTTP proxy from 127.0.0.1 to vyred's unix socket so a browser can open the Deck.
//
// A test helper, not part of the product. Never touches ~/.vyre.
//
//   node deck/test/world.js [port]      prints the URL, runs until Ctrl-C, then removes the home

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSIONS, HOME, writeTranscripts } from "../../test/fixtures/corpus.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(REPO, "bin", "vyre");
const PORT = Number(process.argv[2] || 4747);

const root = fs.realpathSync(fs.mkdtempSync("/tmp/vy-deck-"));
if (path.resolve(root) === path.resolve(os.homedir(), ".vyre")) throw new Error("refusing to use the real ~/.vyre");
const work = path.join(root, "alex", "Work");
const moved = SESSIONS.map(s => ({ ...s, cwd: s.cwd.replace(path.join(HOME, "Work"), work).replace(HOME, path.join(root, "alex")) }));
for (const s of moved) fs.mkdirSync(s.cwd, { recursive: true });
const transcripts = path.join(root, "transcripts");
writeTranscripts(transcripts, moved);
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  name: "alex", projectsDir: path.join(root, "projects"), roots: [work], transcripts: [transcripts],
  recall: { vectors: false, download: false },
}, null, 2));

const env = { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_HARNESS_DIR: path.join(root, "no-harness") };
const vyre = (/** @type {string[]} */ args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });

const daemon = spawn(process.execPath, [path.join(REPO, "core", "daemon", "main.js")], { env, stdio: "inherit" });
const { socketPath } = await import("../../core/config/index.js");
const sock = socketPath(root);
for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 100));
if (!fs.existsSync(sock)) throw new Error("vyred did not come up");

// Let the first Recall pass land so the catalogue and search see the corpus.
await new Promise(r => setTimeout(r, 1500));
const [SITE, INTAKE, NORTH, HUB] = moved.map(s => s.id);
vyre(["new", "Harlow Legal", "--home", path.join(work, "harlow-site"), "--thread", INTAKE, "--thread", HUB,
  "--person", "Dana Reyes <dana@harlowlegal.com>", "--org", "Rivera Studio", "--no-pick"]);
vyre(["new", "Northwind Bakery", "--home", path.join(work, "northwind"), "--person", "Sam Okafor <billing@northwindbakery.com>", "--no-pick"]);
void SITE; void NORTH;

const server = http.createServer((req, res) => {
  const up = http.request({ socketPath: sock, path: req.url, method: req.method, headers: req.headers }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", e => { res.writeHead(502); res.end(String(e.message)); });
  req.pipe(up);
});
server.listen(PORT, "127.0.0.1", () => console.log(`deck world: http://127.0.0.1:${PORT}/  (home ${root})`));

const quit = () => {
  server.close();
  daemon.kill("SIGTERM");
  daemon.on("exit", () => { fs.rmSync(root, { recursive: true, force: true }); process.exit(0); });
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
