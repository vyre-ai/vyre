// The wall against the INSTALLED product, for the watchers-isolation workflow: pack the package,
// install it into a throwaway prefix, run its `vyre daemon` as an ordinary user in a temp VYRE_HOME,
// create a project and a watcher through the CLI, probe from inside the watcher (a loopback socket,
// vyred's own socket by path, a signal to vyred, the home directory, a file outside its folder), then
// stop the daemon and uninstall. Runs on a hosted runner only. VYRE_EXPECT_WALL: bwrap, sandbox-exec
// or none (then the watcher must refuse to run, in words).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

if (process.env.CI !== "true") { console.error("check-wall-installed runs on a CI runner only"); process.exit(2); }
const expect = process.env.VYRE_EXPECT_WALL || "";
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...o });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-installed-"));
const prefix = path.join(tmp, "prefix"), root = path.join(tmp, "vyre-home"), proj = path.join(tmp, "project");
fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(proj);
const tarball = path.join(tmp, sh("npm", ["pack", "--silent", "--pack-destination", tmp]).trim().split("\n").pop());
sh("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", "--omit=dev", tarball]);
const vyre = path.join(prefix, "bin", "vyre");
assert.ok(fs.existsSync(vyre), "the installed package has no vyre command");
const env = { ...process.env, VYRE_HOME: root, PATH: `${path.join(prefix, "bin")}:${process.env.PATH}` };
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ roots: [], transcripts: [path.join(root, "no-transcripts")], vault: { keystore: "file" } }));
const call = (tool, input) => JSON.parse(sh(vyre, ["call", tool, JSON.stringify(input || {})], { env }));

const daemon = spawn(vyre, ["daemon"], { env, stdio: "ignore" });
let up = false;
for (let i = 0; i < 60 && !up; i++) { try { call("system.echo", { text: "hi" }); up = true; } catch { await new Promise(r => setTimeout(r, 500)); } }
assert.ok(up, "the installed vyred did not come up");
let failed = null;
try {
  call("projects.create", { name: "Harlow Legal", home: proj });
  const dir = call("watchers.list").dir;
  const lo = net.createServer(c => c.end());
  await new Promise(r => lo.listen(0, "127.0.0.1", () => r()));
  const port = lo.address().port;
  const sock = path.join(root, "vyred.sock");
  const outside = path.join(tmp, "outside.txt"); fs.writeFileSync(outside, "outside", { mode: 0o600 });
  const w = path.join(dir, "probe"); fs.mkdirSync(w, { recursive: true });
  fs.writeFileSync(path.join(w, "watcher.json"), JSON.stringify({ name: "probe", project: "harlow-legal", schedule: "*/15 * * * *" }));
  fs.writeFileSync(path.join(w, "watch.js"), `import fs from "node:fs";
import net from "node:net";
const attempt = f => new Promise(res => { try { f(res); } catch (e) { res("blocked:" + e.code); } setTimeout(() => res("blocked:TIMEOUT"), 3000); });
export default async function watch({ emit }) {
  const out = {};
  out.tcp = await attempt(res => { const s = net.connect(${port}, "127.0.0.1"); s.on("connect", () => res("connected")); s.on("error", e => res("blocked:" + e.code)); });
  out.vyredSocket = await attempt(res => { const s = net.connect(${JSON.stringify(sock)}); s.on("connect", () => res("connected")); s.on("error", e => res("blocked:" + e.code)); });
  out.signal = await attempt(res => { process.kill(${daemon.pid}, 0); res("signalled"); });
  out.home = await attempt(res => { res("listed:" + fs.readdirSync(${JSON.stringify(os.homedir())}).length); });
  out.outside = await attempt(res => { res("read:" + fs.readFileSync(${JSON.stringify(outside)}, "utf8")); });
  emit({ id: "probe", title: JSON.stringify(out) });
}`);
  const r = call("watchers.test", { name: "probe" });
  if (!expect || expect === "none") {
    if (!r.ok) {
      assert.match(r.error, /watchers cannot run on this machine: it has no way to keep a watcher off the network/);
      console.log("no wall here, and the installed product refused to run the watcher:", r.error);
    } else assert.ok(!expect, "this job expected no wall");
  }
  if (r.ok) {
    assert.ok(!expect || expect === "none" ? true : r.wall === expect, `wall was ${r.wall}, expected ${expect}`);
    const got = JSON.parse(r.items[0].title);
    console.log("probe from the installed watcher:", JSON.stringify(got), "wall:", r.wall);
    for (const k of Object.keys(got)) assert.match(got[k], /^blocked/, `the installed watcher got through on ${k}: ${got[k]}`);
  } else assert.ok(!expect || expect === "none", `a wall was expected (${expect}) and the watcher did not run: ${r.error || JSON.stringify(r)}`);
  lo.close();
} catch (e) { failed = e; }
daemon.kill("SIGTERM");
sh("npm", ["rm", "-g", "--prefix", prefix, "vyre"]);
if (!failed) { assert.ok(!fs.existsSync(vyre), "uninstall left the vyre command behind"); }
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) throw failed;
console.log("installed-product wall check passed");
