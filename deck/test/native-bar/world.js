// @ts-check
// The native bar's world: the Deck of any Vyre tree, in a temp home, with the bar's own fake claude.
//
//   node deck/test/native-bar/world.js --tree <path> [--port 4791]
//
// It makes a temp VYRE_HOME under that tree's test SCRATCH folder, writes two seeded transcripts
// (40 rows and 2,000 rows: user, assistant and tool rows mixed), starts the tree's own vyred with
// VYRE_NO_DIALOGS=1, the fake tailscale and native-bar/fake-claude.js, and serves the Deck over a
// plain HTTP proxy to vyred's socket. The proxy also answers a few harness routes:
//   GET  /__bar/now          the server's clock (one round trip syncs the page's)
//   GET  /__bar/log          what the fake claude logged per burst (first and last delta, epoch ms)
//   POST /__bar/drop?ms=N    cut every open event stream and refuse new ones for N ms, as a lost
//                            network does (sockets destroyed, never an HTTP error)
// When ready it prints one JSON line: {"ready": true, url, s40, s2000, cwd}. SIGTERM stops vyred
// and removes the temp folders. A test helper, not part of the product. Never touches ~/.vyre.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(HERE, "..", "..", "..");
const args = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const TREE = path.resolve(arg("--tree", HARNESS));
const PORT = Number(arg("--port", "4791"));
const imp = (/** @type {string} */ rel) => import(pathToFileURL(path.join(TREE, rel)).href);

const { SCRATCH } = await imp("test/scratch.mjs");
const root = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vy-bar-")));
if (path.resolve(root) === path.resolve(os.homedir(), ".vyre")) throw new Error("refusing to use the real ~/.vyre");
const alexTmp = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vy-bar-alex-")));
const cleanup = () => { for (const d of [root, alexTmp]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);
const alex = path.join(alexTmp, "alex");
const work = path.join(alex, "Work");
const cwd = path.join(work, "northwind");
fs.mkdirSync(cwd, { recursive: true });
const transcripts = path.join(root, "transcripts");
fs.mkdirSync(transcripts, { recursive: true });
const fakeLog = path.join(root, "fake-bar.jsonl");

// ---- seeded transcripts --------------------------------------------------------------------

/** A Claude Code transcript of about `rows` rows: user, assistant text and tool rows in turn. */
function writeSession(/** @type {number} */ rows, /** @type {string} */ name) {
  const id = crypto.randomUUID();
  const dir = path.join(transcripts, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  let parent = null, t = Date.now() - 2 * 3600_000, k = 0;
  const step = Math.max(200, Math.floor(3600_000 / rows));
  const line = (/** @type {string} */ type, /** @type {any} */ message, extra = {}) => {
    const uuid = crypto.randomUUID();
    lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId: id, version: "2.1.283", gitBranch: "",
      type, message, uuid, timestamp: new Date(t += step).toISOString(), ...extra }));
    parent = uuid;
  };
  const items = ["sourdough", "rye", "seasonal tart", "cinnamon bun", "baguette", "focaccia"];
  let made = 0;
  if (name) lines.push(JSON.stringify({ type: "summary", summary: name, leafUuid: "none" }));
  while (made < rows) {
    k++;
    const item = items[k % items.length];
    line("user", { role: "user", content: `Row ${k}: alex asks juno to check the ${item} price on the Northwind Bakery menu and tidy the wording.` }); made++;
    const mid = `msg_${id.slice(0, 8)}_${k}`;
    line("assistant", { id: mid + "a", type: "message", role: "assistant", model: "fake-model", content: [{ type: "text",
      text: `I checked the ${item} entry (row ${k}). The price reads **${(4 + (k % 5)).toFixed(2)}** and the note is short enough.\n\n- kept the heading\n- fixed one typo` }],
      stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } }); made++;
    if (made >= rows) break;
    const tu = `toolu_${id.slice(0, 8)}_${k}`;
    line("assistant", { id: mid + "b", type: "message", role: "assistant", model: "fake-model", content: [{ type: "tool_use", id: tu, name: "Read", input: { file_path: path.join(cwd, `menu-${k}.md`) } }],
      stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 20 } });
    line("user", { role: "user", content: [{ tool_use_id: tu, type: "tool_result", content: `     1→# ${item}\n     2→${(4 + (k % 5)).toFixed(2)}`, is_error: false }] }, { toolUseResult: item });
    made++;
    if (made >= rows) break;
    line("assistant", { id: mid + "c", type: "message", role: "assistant", model: "fake-model", content: [{ type: "text", text: `Row ${k} is done. Next is the ${items[(k + 1) % items.length]}.` }],
      stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } }); made++;
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  return id;
}
const s40 = writeSession(40, "Northwind menu, short");
const s2000 = writeSession(2000, "Northwind menu, long");

fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  name: "alex", projectsDir: path.join(root, "projects"), roots: [work], transcripts: [transcripts],
  recall: { vectors: false, download: false }, files: { roots: [alex] }, vault: { keystore: "file", breach: "off" },
}, null, 2));

// ---- vyred, from the tree being measured ------------------------------------------------------

const fakeClaude = path.join(HERE, "fake-claude.js");
fs.chmodSync(fakeClaude, 0o755);
// Opt-in fake GitHub (--fake-github): a global fetch() intercept preloaded into the daemon child
// with --import, so github.connect runs for real against connect.js's real URLs but never reaches
// the network (deck/test/native-bar/fake-github.mjs). Off unless asked for, so every other world
// caller is unaffected.
const fakeGithub = args.includes("--fake-github");
const env = { ...process.env, VYRE_HOME: root, VYRE_DECK_FIXTURES: "1", VYRE_NO_DIALOGS: "1", NO_COLOR: "1", VYRE_HARNESS_DIR: path.join(root, "no-harness"),
  VYRE_TAILSCALE_BIN: path.join(HARNESS, "deck", "test", "fake-tailscale.js"),
  VYRE_CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_TRANSCRIPTS: transcripts, FAKE_BAR_LOG: fakeLog,
  ...(fakeGithub ? { FAKE_GITHUB_ENABLE: "1", FAKE_GITHUB_LOGIN: arg("--fake-github-login", "alex-harlow"), FAKE_GITHUB_PENDING_POLLS: arg("--fake-github-pending", "1") } : {}) };
const { socketPath } = await imp("core/config/index.js");
const { call } = await imp("core/daemon/client.js");
const sock = socketPath(root);
const daemonArgs = [...(fakeGithub ? ["--import", pathToFileURL(path.join(HERE, "fake-github.mjs")).href] : []), path.join(TREE, "core", "daemon", "main.js")];
const daemon = spawn(process.execPath, daemonArgs, { env, stdio: ["ignore", "ignore", "inherit"] });
const answers = () => call("system.info", {}, { root, timeout: 1000 }).then((/** @type {any} */ r) => !!r.data, () => false);
for (let i = 0; i < 150 && !(await answers()); i++) await new Promise(r => setTimeout(r, 100));
if (!(await answers())) { console.error("native-bar world: vyred did not come up"); daemon.kill("SIGTERM"); process.exit(1); }

// Recall has to have read both transcripts before the Deck can open them.
for (const id of [s40, s2000]) {
  for (let i = 0; i < 240; i++) {
    const r = await call("recall.transcript", { session: id, limit: 5 }, { root, caller: "cli" }).catch(() => ({}));
    if (r.data && r.data.blocks && r.data.blocks.length) break;
    await new Promise(r => setTimeout(r, 250));
  }
}

// ---- the proxy, with the harness routes ---------------------------------------------------------

/** @type {Set<import("node:net").Socket>} */
const streams = new Set();
let downUntil = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  if (u.pathname === "/__bar/now") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ now: Date.now() })); return; }
  if (u.pathname === "/__bar/log") {
    let lines = []; try { lines = fs.readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch {}
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(lines)); return;
  }
  if (u.pathname === "/__bar/drop") {
    downUntil = Date.now() + Number(u.searchParams.get("ms") || 2000);
    const n = streams.size;
    for (const s of streams) s.destroy();
    streams.clear();
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ dropped: n, until: downUntil })); return;
  }
  const isStream = u.pathname.startsWith("/v1/events/stream");
  if (isStream && Date.now() < downUntil) { req.socket.destroy(); return; }
  if (isStream) { const s = req.socket; streams.add(s); s.on("close", () => streams.delete(s)); }
  const up = http.request({ socketPath: sock, path: req.url, method: req.method, headers: req.headers }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", e => { try { res.writeHead(502); res.end(String(e.message)); } catch {} });
  res.on("close", () => up.destroy());
  req.pipe(up);
});
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(sock, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n");
    if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
});
server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ ready: true, url: `http://127.0.0.1:${PORT}`, s40, s2000, cwd, home: root }) + "\n");
});

const quit = () => {
  server.close();
  for (const s of streams) s.destroy();
  daemon.once("exit", () => process.exit(0));
  daemon.kill("SIGTERM");
  setTimeout(() => { try { daemon.kill("SIGKILL"); } catch {} process.exit(0); }, 5000).unref();
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
