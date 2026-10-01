// The vyred side of the joint box proof, run inside the box container as uid vyre, using the REAL
// watchers code (spawner wall candidate, probe, runOnce) over the REAL spawner:
//   node watcher-wall-joint-driver.mjs run    find the wall; run a watcher through it; print one JSON line
//   node watcher-wall-joint-driver.mjs find   find the wall only; print one JSON line
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { findWall } from "/opt/vyre/core/watchers/spawner-wall.js";
import { runOnce } from "/opt/vyre/core/watchers/run.js";

const mode = process.argv[2] || "run";
const found = await findWall();
const out = { wall: found.wall ? found.wall.kind : null, why: found.why };
if (mode === "find" || !found.wall) { console.log(JSON.stringify(out)); process.exit(0); }

// A real listener on the loopback, so a refusal means the wall and not an empty port.
let saw = 0;
const lo = net.createServer(s => { saw++; s.destroy(); });
await new Promise(r => lo.listen(0, "127.0.0.1", () => r(undefined)));
const port = lo.address().port;

const dir = fs.mkdtempSync(path.join(os.homedir(), "joint-"));
fs.writeFileSync(path.join(dir, "watcher.json"), JSON.stringify({ name: "joint", project: "p", schedule: "*/15 * * * *" }));
fs.writeFileSync(path.join(dir, "note.txt"), "handed in");
fs.writeFileSync(path.join(dir, "watch.js"), `import fs from "node:fs";
import net from "node:net";
const attempt = f => new Promise(res => { try { f(res); } catch (e) { res("blocked:" + (e.code || e.message)); } setTimeout(() => res("blocked:TIMEOUT"), 3000); });
export default async function watch({ emit }) {
  const v = {};
  v.note = fs.readFileSync(new URL("./note.txt", import.meta.url), "utf8");
  v.uid = process.getuid();
  v.tcp = await attempt(res => { const s = net.connect(${port}, "127.0.0.1"); s.on("connect", () => res("connected")); s.on("error", e => res("blocked:" + e.code)); });
  v.internet = await attempt(res => { const s = net.connect(443, "1.1.1.1"); s.on("connect", () => res("connected")); s.on("error", e => res("blocked:" + e.code)); });
  v.spawnerSock = await attempt(res => { const s = net.connect("/run/vyre/spawner.sock"); s.on("connect", () => res("connected")); s.on("error", e => res("blocked:" + e.code)); });
  v.vyreHome = await attempt(res => res("listed:" + fs.readdirSync("/home/vyre").length));
  v.work = await attempt(res => res("listed:" + fs.readdirSync("/work").length));
  v.signal = await attempt(res => { process.kill(${process.pid}, 0); res("signalled"); });
  emit({ id: "joint", title: JSON.stringify(v) });
}`);
const r = await runOnce({ dir, needs: [], since: null, timeoutMs: 25000, fetch: async () => "", wall: found.wall });
console.log(JSON.stringify({ ...out, error: r.error, wallUsed: r.wall, unisolated: Boolean(r.unisolated), verdict: r.items && r.items[0] ? JSON.parse(r.items[0].title) : null, listenerSaw: saw, logs: r.logs.slice(-5) }));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
