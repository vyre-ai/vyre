// @ts-check
// A throwaway world for looking at the Deck: a temp VYRE_HOME under the test SCRATCH folder, the
// fictional corpus written as real transcripts, a real vyred, two projects made with `vyre new`,
// juno, kit, a few vault items, and a plain HTTP proxy from 127.0.0.1 to vyred's unix socket so a
// browser can open the Deck.
//
// A test helper, not part of the product. Never touches ~/.vyre.
//
//   node deck/test/world.js [port]      prints the URL, runs until Ctrl-C, then removes the home

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSIONS, HOME, writeTranscripts } from "../../test/fixtures/corpus.js";
import { SCRATCH } from "../../test/scratch.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(REPO, "bin", "vyre");
const PORT = Number(process.argv[2] || 4747);

const root = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vy-deck-")));
if (path.resolve(root) === path.resolve(os.homedir(), ".vyre")) throw new Error("refusing to use the real ~/.vyre");
// alex's folders sit beside the Vyre home, not in it: the files guard never shows anything inside
// Vyre's own home, so Chat's folder browser and terminal would find nothing there.
const alex = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vy-alex-")));
const work = path.join(alex, "Work");
const moved = SESSIONS.map(s => ({ ...s, cwd: s.cwd.replace(path.join(HOME, "Work"), work).replace(HOME, alex) }));
for (const s of moved) fs.mkdirSync(s.cwd, { recursive: true });
const transcripts = path.join(root, "transcripts");
writeTranscripts(transcripts, moved);
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  name: "alex", projectsDir: path.join(root, "projects"), roots: [work], transcripts: [transcripts],
  recall: { vectors: false, download: false },
  // Chat's folder browser and terminal see alex's sample folders, never this machine's home.
  files: { roots: [alex] },
  // A key file in the temp home, never the login keychain, and no breach lookups over the network.
  vault: { keystore: "file", breach: "off" },
  // Two fictional senders, so the Gate has something real to hold: the vault items are never
  // fetched here (nothing is approved), only named, so no credential is needed to look at Now
  // or a held item.
  gate: { senders: {
    mail: { type: "gmail", vault: "harlow-gmail", from: "alex@harlowlegal.com" },
    billing: { type: "http", vault: "northwind-ads", hosts: ["https://api.example.com"] },
  } },
}, null, 2));

// VYRE_NO_DIALOGS: a world never raises Touch ID, a notification or an app on the user's screen.
// VYRE_TAILSCALE_BIN: a sample tailnet (fake-tailscale.js), never the real Tailscale of this machine.
const env = { ...process.env, VYRE_HOME: root, VYRE_NO_DIALOGS: "1", NO_COLOR: "1", VYRE_HARNESS_DIR: path.join(root, "no-harness"),
  VYRE_TAILSCALE_BIN: path.join(REPO, "deck", "test", "fake-tailscale.js"),
  // A send from the Deck resumes a session headless: with the Switchboard's fake claude, which
  // streams an echo back (or asks permission for "write <file>"), never the real one.
  VYRE_CLAUDE_BIN: path.join(REPO, "deck", "test", "fake-claude.js"),
  // The fake writes its turns as transcripts too, where Recall reads them, so Chat's rich view
  // (recall.transcript) has tool cards, diffs and todos to draw.
  FAKE_CLAUDE_TRANSCRIPTS: transcripts };
const vyre = (/** @type {string[]} */ args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });

const { socketPath } = await import("../../core/config/index.js");
const { call } = await import("../../core/daemon/client.js");
const sock = socketPath(root);
/** @param {string} main */
const startVyred = async main => {
  const d = spawn(process.execPath, [main], { env, stdio: "inherit" });
  const answers = () => call("system.info", {}, { root, timeout: 1000 }).then(r => !!r.data, () => false);
  for (let i = 0; i < 100 && !(await answers()); i++) await new Promise(r => setTimeout(r, 100));
  if (!(await answers())) throw new Error("vyred did not come up");
  return d;
};
const down = (/** @type {import("node:child_process").ChildProcess} */ d) => new Promise(r => { d.once("exit", r); d.kill("SIGTERM"); });

// The vault items first, through a vyred that finds a person at every call (a test fixture that
// refuses any home outside the temp folder): vault.put asks for presence, and a world has no one
// to press Touch ID. That vyred stops before the real one starts, so nothing the Deck does later
// (a Send at the Gate, say) is ever approved without a person. Every value is random and fictional.
{
  const seeding = await startVyred(path.join(REPO, "test", "fixtures", "vyred-present.js"));
  const fake = () => crypto.randomBytes(18).toString("base64url");
  const put = async (/** @type {any} */ x) => { const r = await call("vault.put", x, { root, caller: "cli" }); if (r.error) console.error(`world: vault.put ${x.name}: ${r.error.message}`); };
  await put({ name: "harlow-gmail", kind: "login", description: "Harlow Legal's mailbox, for client updates.", url: "https://mail.google.com", fields: { username: "alex@harlowlegal.com", password: fake() } });
  await put({ name: "northwind-ads", kind: "api-key", description: "Northwind Bakery's ad account.", hosts: ["https://api.example.com"], fields: { value: fake() } });
  await put({ name: "claude-setup-token", kind: "secret", description: "The Claude subscription token juno and kit run on.", fields: { value: fake() } });
  await put({ name: "northwind-card", kind: "card", description: "Northwind Bakery's company card.", fields: { name: "Sam Okafor", number: "4242424242424242", expiry: "09/29", cvc: "123" } });
  await put({ name: "office-wifi", kind: "note", fields: { text: "Network harlow-guest. Ask Dana for the printer code." } });
  await put({ name: "harlow-site-env", kind: "env-set", description: "The Harlow Legal site's production settings.", fields: { DATABASE_URL: "postgres://sample/" + fake(), MAIL_KEY: fake() } });
  // CHAT_DEMO: one finished Claude Code session with the fake's rich turn (thinking, Read, Edit,
  // Bash, a todo list), its permission asks answered here, where a person is found, so Chat has
  // a whole session to draw. The thread stops with this vyred; its transcript and record stay.
  if (process.env.CHAT_DEMO) {
    const t = await call("threads.start", { cwd: moved[0].cwd, prompt: "demo", name: "Tidy the intake form", surface: "cli" }, { root, caller: "cli" });
    const id = t.data && t.data.id;
    for (let i = 0; id && i < 100; i++) {
      for (const a of (await call("threads.asks", { thread: id }, { root, caller: "cli" })).data || [])
        await call("threads.answer", { ask: a.id, decision: "allow", surface: "cli" }, { root, caller: "cli" });
      const g = await call("threads.get", { thread: id, limit: 1 }, { root, caller: "cli" });
      if (g.data && g.data.thread.turns >= 1 && g.data.thread.status === "idle") break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (id) await call("threads.stop", { thread: id }, { root, caller: "cli" });
    // The seed typed as cli; give the keyboard back so the finished demo reads as nobody's.
    if (id) await call("threads.release", { thread: id, surface: "cli" }, { root, caller: "cli" });
  }
  await down(seeding);
}
const daemon = await startVyred(path.join(REPO, "core", "daemon", "main.js"));

// Let the first Recall pass land so the catalogue and search see the corpus.
await new Promise(r => setTimeout(r, 1500));
const [SITE, INTAKE, NORTH, HUB] = moved.map(s => s.id);
vyre(["new", "Harlow Legal", "--home", path.join(work, "harlow-site"), "--thread", INTAKE, "--thread", HUB,
  "--person", "Dana Reyes <dana@harlowlegal.com>", "--org", "Rivera Studio", "--no-pick"]);
vyre(["new", "Northwind Bakery", "--home", path.join(work, "northwind"), "--person", "Sam Okafor <billing@northwindbakery.com>", "--no-pick"]);
void SITE; void NORTH;

// The assistant and one agent, as the CLI would make them. agents.create only records an agent:
// it starts no claude and no computer.
const cli = (/** @type {string} */ tool, /** @type {any} */ input) => call(tool, input, { root, caller: "cli" }).then(r => { if (r.error) console.error(`world: ${tool}: ${r.error.message}`); });
await cli("agents.create", { name: "juno", kind: "assistant", auth: { vault: "claude-setup-token", budget_usd: 20 },
  instructions: "Run alex's week: keep every project moving, draft client updates, and ask before anything goes out." });
await cli("agents.create", { name: "kit", kind: "agent", projects: ["harlow-legal", "northwind-bakery"], computer: true, auth: { vault: "claude-setup-token", budget_usd: 15 },
  instructions: "Run marketing for Harlow Legal and Northwind Bakery. Write ad copy, audit campaigns, and ask before spending money or publishing anything." });

const server = http.createServer((req, res) => {
  const up = http.request({ socketPath: sock, path: req.url, method: req.method, headers: req.headers }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", e => { res.writeHead(502); res.end(String(e.message)); });
  req.pipe(up);
});
// WebSockets (Chat's terminal, Glass) go through to vyred's socket as they are.
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(sock, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n");
    if (head && head.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
});
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`deck world: http://127.0.0.1:${PORT}/  (home ${root})`);
  // CHAT_DEMO: two live sessions waiting on the user, one with a question and one with a
  // permission ask, for Chat's cards. Nobody answers them here: that takes a person.
  if (process.env.CHAT_DEMO) {
    const start = (/** @type {any} */ body) => fetch(`http://127.0.0.1:${PORT}/v1/tools/threads.start`, { method: "POST",
      headers: { "content-type": "application/json", "x-vyre-caller": "deck" }, body: JSON.stringify({ surface: "deck", ...body }) }).catch(() => {});
    await start({ cwd: moved[2].cwd, prompt: "ask", name: "Northwind menu page" });
    await start({ cwd: moved[0].cwd, prompt: "demo", name: "Intake form, second pass" });
  }
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

// Belt and suspenders on the vy-deck-* home: the "exit" event fires for every path out of
// this process (Ctrl-C below, an uncaught exception, a thrown "vyred did not come up"), not just
// a clean quit, so the temp dir does not outlive the process. fs.rmSync is sync, which "exit"
// handlers require.
process.on("exit", () => { for (const d of [root, alex]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

const quit = () => {
  server.close();
  daemon.kill("SIGTERM");
  daemon.on("exit", () => process.exit(0));
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
