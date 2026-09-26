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
  // The file keystore: a throwaway world never writes to the login keychain.
  vault: { keystore: "file" },
  // Two fictional senders, so the Gate has something real to hold: the vault items are never
  // fetched here (nothing is approved), only named, so no credential is needed to look at Now
  // or a held item.
  gate: { senders: {
    mail: { type: "gmail", vault: "harlow-gmail", from: "alex@harlowlegal.com" },
    billing: { type: "http", vault: "northwind-ads", hosts: ["https://api.example.com"] },
  } },
}, null, 2));

// VYRE_NO_DIALOGS: nothing this world runs may raise a prompt on the Mac it runs on.
const env = { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1", VYRE_HARNESS_DIR: path.join(root, "no-harness") };
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
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`deck world: http://127.0.0.1:${PORT}/  (home ${root})`);
  // Two items held at the Gate, so Now and /needs/:id have something real (not a fixture) to
  // show. request() only holds; nothing is sent. A vyred without the gate module ignores this.
  const base = `http://127.0.0.1:${PORT}/v1/tools/`;
  const hold = async (name, body) => {
    try { await fetch(base + name, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); } catch {}
  };
  await hold("gate.request", { kind: "send", via: "mail", to: ["dana@harlowlegal.com"], agent: "juno", thread: INTAKE, project: "harlow-legal",
    why: "It is juno's first email to a client this week, so I stopped before sending.",
    content: { subject: "Q3 report, the short version",
      body: "Hi Dana,\n\nThe Q3 report is attached. Consult bookings rose every month this quarter, and the new intake form goes live next week. Theo has the full numbers on page 2.\n\nAlex" } });
  await hold("gate.request", { kind: "spend", via: "billing", to: ["https://api.example.com"], agent: "kit", project: "northwind-bakery",
    why: "Spending money always waits for you.",
    content: { method: "POST", url: "https://api.example.com/v1/topups", body: JSON.stringify({ account: "northwind-ads", amount_usd: 150 }) } });
});

// Belt and suspenders on the /tmp/vy-deck-* home: the "exit" event fires for every path out of
// this process (Ctrl-C below, an uncaught exception, a thrown "vyred did not come up"), not just
// a clean quit, so the temp dir does not outlive the process. fs.rmSync is sync, which "exit"
// handlers require.
process.on("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

const quit = () => {
  server.close();
  daemon.kill("SIGTERM");
  daemon.on("exit", () => process.exit(0));
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
