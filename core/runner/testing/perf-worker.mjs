// The workload for scripts/runner-perf.mjs. Same code runs in a plain folder and inside the sandbox in the encrypted workspace.
// stdin: "run <scenario> [arg]" per line; stdout: {"scenario","ms","note"} then {"type":"result"}.
import fs from "node:fs"; import path from "node:path"; import http from "node:http"; import crypto from "node:crypto"; import { spawnSync } from "node:child_process";
const cwd = process.cwd();
const out = o => process.stdout.write(JSON.stringify(o) + "\n");
const t = fn => { const s = process.hrtime.bigint(); const note = fn(); return { ms: Number(process.hrtime.bigint() - s) / 1e6, note }; };
const tree = (dir, files, size) => { for (let i = 0; i < files; i++) { const d = path.join(dir, "d" + (i % 200)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `f${i}.txt`), crypto.randomBytes(size / 2).toString("hex")); } };
const S = {
  writes: () => t(() => { const d = path.join(cwd, "w"); fs.mkdirSync(d, { recursive: true }); for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(d, `f${i}`), "x".repeat(200)); }),
  search: () => { const d = path.join(cwd, "s"); if (!fs.existsSync(d)) tree(d, 5000, 2000); return t(() => { let n = 0; const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else if (fs.readFileSync(f, "utf8").includes("abcdef0123")) n++; } }; walk(d); return n + " hits"; }); },
  extract: () => t(() => { tree(path.join(cwd, "x" + Date.now()), 20000, 2000); }),
  cpu: () => t(() => { let h = Buffer.alloc(32); for (let i = 0; i < 200000; i++) h = crypto.createHash("sha256").update(h).digest(); return "200k sha256"; }),
  clone: () => { const g = (...a) => spawnSync("git", a, { cwd, encoding: "utf8" }); const src = path.join(cwd, "src"); if (!fs.existsSync(src)) { tree(src, 2000, 2000); g("init", "-q", "src"); spawnSync("git", ["-C", src, "add", "-A"]); spawnSync("git", ["-C", src, "-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "x"]); }
    const dst = path.join(cwd, "dst" + Date.now()); const r = t(() => { const c = g("clone", "-q", "--no-hardlinks", src, dst); return c.status === 0 ? "ok" : "git failed: " + String(c.stderr).slice(0, 80); }); return r; },
};
let buf = "";
process.stdin.on("data", async d => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    const [cmd, name, arg] = line.split(" ");
    if (cmd !== "run") continue;
    if (name === "calls") {   // per-call latency of a request through the base URL (the egress proxy when lent) or directly
      const base = new URL(arg || process.env.ANTHROPIC_BASE_URL); const agent = new http.Agent({ keepAlive: true }); const times = [];
      for (let k = 0; k < 300; k++) { const s = process.hrtime.bigint(); await new Promise(res => { http.get({ hostname: base.hostname, port: base.port, path: base.pathname.replace(/\/$/, "") + "/v1/messages", agent, headers: { "x-api-key": process.env.ANTHROPIC_API_KEY || "none" } }, m => { m.resume(); m.on("end", res); }).on("error", res); }); times.push(Number(process.hrtime.bigint() - s) / 1e6); }
      times.sort((a, b) => a - b); out({ scenario: name, ms: times[150], note: `p50 ${times[150].toFixed(2)} p95 ${times[285].toFixed(2)} max ${times[299].toFixed(2)}` });
    } else if (S[name]) { const r = S[name](); out({ scenario: name, ms: r.ms, note: r.note }); }
    out({ type: "result" });
  }
});
out({ type: "ready" });
