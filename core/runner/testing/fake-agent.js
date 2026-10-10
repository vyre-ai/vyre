// A stand-in for the agent a session runs (Claude Code in real use). Reads lines on stdin, answers with stream-json
// lines on stdout, and ends each turn with { type: "result" }. Used by the runner tests inside the real sandbox.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";

const out = o => process.stdout.write(JSON.stringify(o) + "\n");
const home = process.env.HOME || "";
if (process.env.VYRE_RESUME_TURN) {
  const files = fs.readdirSync(process.cwd()).sort();
  let notes = ""; try { notes = fs.readFileSync(path.join(process.cwd(), "notes.txt"), "utf8"); } catch {}
  out({ type: "resumed", turn: Number(process.env.VYRE_RESUME_TURN), files, notes });
}
// VYRE_AUTO_TURN_MS: a turn on its own every so many milliseconds, for tests that run a session without anyone typing to it (the chaos suite, scripts/runner-chaos.mjs)
if (process.env.VYRE_AUTO_TURN_MS) { let n = 0; const every = Number(process.env.VYRE_AUTO_TURN_MS); setInterval(() => { handle("turn auto" + (++n)).catch(() => {}); }, every); }
let buf = "";
process.stdin.on("data", d => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handle(line.trim()); }
});

async function handle(line) {
  const [cmd, ...rest] = line.split(" ");
  const arg = rest.join(" ");
  if (cmd === "turn") {
    fs.appendFileSync(path.join(process.cwd(), "notes.txt"), arg + "\n");
    fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    fs.appendFileSync(path.join(home, ".claude", "projects", "s.jsonl"), JSON.stringify({ said: arg }) + "\n");
    out({ type: "assistant", text: "did " + arg });
    out({ type: "result" });
  } else if (cmd === "half") {
    // Starts a turn, changes a file, and dies before the turn ends.
    fs.writeFileSync(path.join(process.cwd(), "half.txt"), "half-done " + arg);
    out({ type: "assistant", text: "half " + arg });
    process.exit(3);
  } else if (cmd === "probe") {
    const r = { type: "probe" };
    try { fs.readFileSync(process.env.VYRE_PROBE_FILE); r.outside = "READ"; } catch (e) { r.outside = e.code; }
    try { r.homeList = fs.readdirSync(process.env.VYRE_PROBE_HOME).length; } catch (e) { r.homeList = e.code; }
    r.envHasSecret = Object.values(process.env).some(v => /REAL-.*SECRET/.test(String(v)));
    r.envToken = !!process.env.ANTHROPIC_API_KEY;
    r.net = await new Promise(res => { const s = net.connect(Number(process.env.VYRE_PROBE_PORT), "127.0.0.1"); s.on("connect", () => { s.destroy(); res("CONNECTED"); }); s.on("error", e => res(e.code)); setTimeout(() => res("timeout"), 3000); });
    r.net2 = await new Promise(res => { const s = net.connect(53, "8.8.8.8"); s.on("connect", () => { s.destroy(); res("CONNECTED"); }); s.on("error", e => res(e.code)); setTimeout(() => res("timeout"), 3000); });
    const call = (p, headers) => new Promise(res => {
      const u = new URL(process.env.ANTHROPIC_BASE_URL + p);
      const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers }, m => { let b = ""; m.on("data", d => b += d); m.on("end", () => res({ status: m.statusCode, body: b })); });
      q.on("error", e => res({ error: e.code })); q.end();
    });
    r.provider = await call("/v1/messages", { "x-api-key": process.env.ANTHROPIC_API_KEY });
    r.noToken = await call("/v1/messages", {});
    const sp = new URL(process.env.VYRE_SPACE_URL);
    r.space = await new Promise(res => { const q = http.request({ hostname: sp.hostname, port: sp.port, path: sp.pathname + "/gmail/inbox", headers: { authorization: "Bearer " + process.env.VYRE_SPACE_TOKEN } }, m => { let b = ""; m.on("data", d => b += d); m.on("end", () => res({ status: m.statusCode, body: b })); }); q.on("error", e => res({ error: e.code })); q.end(); });
    r.other = await new Promise(res => { const q = http.request({ hostname: sp.hostname, port: sp.port, path: "/elsewhere/x", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY } }, m => res({ status: m.statusCode })); q.on("error", e => res({ error: e.code })); q.end(); });
    out(r);
    out({ type: "result" });
  } else if (cmd === "exit") process.exit(0);
}
