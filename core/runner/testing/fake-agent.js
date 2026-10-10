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
  } else if (cmd === "slowturn") {
    // A turn that takes `ms`: it says it started, and writes its notes and its answer only at the end (a lid that shuts in between cuts it).
    const [ms, ...words] = rest, text = words.join(" ");
    out({ type: "assistant", text: "working " + text });
    await new Promise(r => setTimeout(r, Number(ms) || 1000));
    fs.appendFileSync(path.join(process.cwd(), "notes.txt"), text + "\n");
    out({ type: "assistant", text: "did " + text });
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
  } else if (cmd === "vyre") {
    // a call to Vyre as the session's own, through the door the runner gives it (VYRE_SOCKET): `vyre <tool> <json>`
    const [tool, ...j] = arg.split(" ");
    const reply = await new Promise(res => {
      const data = j.join(" ") || "{}";
      const q = http.request({ socketPath: process.env.VYRE_SOCKET, path: "/v1/tools/" + tool, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-vyre-caller": "mcp" } }, m => { let b = ""; m.on("data", d => b += d); m.on("end", () => res({ status: m.statusCode, body: b })); });
      q.on("error", e => res({ error: e.code })); q.end(data);
    });
    out({ type: "vyre", reply });
    out({ type: "result" });
  } else if (cmd === "mcp") {
    // run Vyre's own MCP server as Claude would (from the --mcp-config the runner gave), ask it for its tools, and say what it answered
    const cfgs = process.argv.flatMap((x, i, a) => (x === "--mcp-config" ? [JSON.parse(a[i + 1])] : []));
    const v = cfgs.map(c => c.mcpServers.vyre).find(Boolean);
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, v.args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...v.env }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", err = ""; const replies = new Map();
    child.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); replies.get(m.id)?.(m); } catch {} } });
    child.stderr.on("data", d => { err += d; });
    const rpc = (id, method, params) => new Promise(res => { const t = setTimeout(() => res({ timeout: true, err: err.slice(0, 600) }), 12000); replies.set(id, m => { clearTimeout(t); res(m); }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
    const list = await rpc(2, "tools/list", {});
    // `mcp <tool> <json>`: also call one tool by its MCP name
    const [tname, ...tj] = arg.split(" ");
    const called = tname ? await rpc(3, "tools/call", { name: tname, arguments: JSON.parse(tj.join(" ") || "{}") }) : null;
    child.kill();
    out({ type: "mcp", init: init.result ? "ok" : init, tools: list.result ? list.result.tools.map(x => x.name) : list, ...(called ? { called: called.result || called } : {}) });
    out({ type: "result" });
  } else if (cmd === "argv") {
    out({ type: "argv", argv: process.argv.slice(2), socket: process.env.VYRE_SOCKET || null });
    out({ type: "result" });
  } else if (cmd === "hook") {
    // run a Harness hook as Claude Code would, from the plugin folder it was given: `hook <piece> <stdin json>`
    const at = process.argv.indexOf(`--${"plugin-dir"}`), plugin = at >= 0 ? process.argv[at + 1] : null;
    const { spawn } = await import("node:child_process");
    const res = await new Promise(done => {
      if (!plugin) return done({ error: "no plugin" });
      const c = spawn(process.execPath, [path.join(plugin, "hooks", "run.js"), rest[0]], { env: { PATH: process.env.PATH, HOME: process.env.HOME, VYRE_SOCKET: process.env.VYRE_SOCKET, VYRE_THREAD: process.env.VYRE_THREAD, CLAUDE_PLUGIN_ROOT: plugin } });
      let o = "", e = ""; c.stdout.on("data", d => { o += d; }); c.stderr.on("data", d => { e += d; }); c.on("close", () => done({ stdout: o, stderr: e.slice(0, 400) }));
      c.stdin.end(rest.slice(1).join(" "));
    });
    out({ type: "hook", ...res });
    out({ type: "result" });
  } else if (cmd === "env") {
    out({ type: "env", name: rest[0], value: process.env[rest[0]] ?? null });
  } else if (cmd === "exit") process.exit(0);
}
