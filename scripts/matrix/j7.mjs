// J7 (agent half): an agent's own computer in Glass, on a CI runner. It runs the computers proof
// (scripts/computers-proof: the image builds, a computer is checked out through the real pool and Docker driver,
// Glass hands out a one-use ticket and a real framebuffer, the person takes over, types and hands back) with
// PROOF_KILL=1, which also kills the container mid-task and checks the pool and Glass say so plainly.
// Each PASS/FAIL line of the proof is folded into the matrix's results by journey step.
//
//   node scripts/matrix/j7.mjs <out-dir>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { recorder } from "./lib/results.mjs";

if (!process.env.CI) { console.error("j7: runs on a CI runner only (CI is unset)"); process.exit(2); }
const out = path.resolve(process.argv[2] || "results");
fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "j7-"));
const r = recorder(out, "J7", "linux-docker");

const t0 = Date.now();
// The proof's output goes to a file as it is written, and the whole process group is killed after 14 minutes, so a hang still
// leaves a log to read (it once ran to the job's own timeout and left nothing).
const logFile = path.join(out, "j7-proof.log");
const fd = fs.openSync(logFile, "w");
const child = spawn("sh", ["scripts/computers-proof/run.sh", work, "47111"], { env: { ...process.env, PROOF_KILL: "1", PROOF_ISOLATION: "1", KEEP_IMAGE: "0" }, stdio: ["ignore", fd, fd], detached: true });
let timedOut = false;
const killer = setTimeout(() => { timedOut = true; try { process.kill(-/** @type {number} */ (child.pid), "SIGKILL"); } catch { /* gone */ } }, 14 * 60_000);
const code = await new Promise(res => child.on("close", c => res(c)));
clearTimeout(killer);
fs.closeSync(fd);
// run.sh's trap removes the proof's containers on a normal exit; after a kill, do it here.
if (timedOut) spawnSync("sh", ["-c", "for c in $(docker ps -aq --filter name=csproof-); do docker rm -f $c >/dev/null 2>&1; done"]);
const run = { status: timedOut ? 124 : code };
const log = fs.readFileSync(logFile, "utf8");
const lines = log.split("\n").map(l => /^(PASS|FAIL) (\S+) (.*)$/.exec(l)).filter(Boolean).map(m => ({ ok: m[1] === "PASS", tag: m[2], text: m[3] }));
const prefix = p => lines.filter(l => l.tag === p || l.tag.startsWith(p));
const fold = (step, tags, why) => {
  const ls = tags.flatMap(t => lines.filter(l => l.tag === t));
  if (!ls.length) { r.step(step, "skip", { why: "the proof stopped before this step" }); return; }
  const bad = ls.filter(l => !l.ok);
  r.step(step, bad.length === 0, { why: bad.length ? `${bad[0].text}`.slice(0, 260) : `${why} (${ls.length} checks)` });
};

fold("7.1a-computer-up", ["4a"], "a computer is checked out through the pool, labelled, limited, no published port");
fold("7.1b-glass-stream", ["4b"], "Glass: one-use ticket, RFB handshake, a real framebuffer, a second viewer");
fold("7.1c-click-and-type-reach-it", ["4c"], "the person's typed line and click through Glass reached the container; a second viewer's input was dropped");
fold("7.1d-hand-back", ["4d"], "the keyboard was handed back, the agent's hands work again");
fold("7.1e-agent-cdp", ["4e"], "the agent acts through computerd's authenticated route, no raw Chrome port");
fold("7.1f-isolation", ["3"], "the image's isolation checks and the browser policy hold on the pool's own container");
r.step("7.2-three-app-plan-oversight", "by-hand", { why: "needs a model run and the oversight panel (capsule-pro's UI); not scriptable on a runner without a vendor account" });
const iso = lines.filter(l => l.tag === "4g");
if (!iso.length) r.step("7.4-computers-cannot-reach-each-other", "skip", { why: "the proof stopped before this step" });
else r.step("7.4-computers-cannot-reach-each-other", iso.every(l => l.ok), { why: iso.map(l => `${l.ok ? "refused" : "REACHED"}: ${l.text.replace(/^[^ ]+ /, "")}`).join("; ").slice(0, 400) });
const caps = lines.filter(l => l.tag === "4h");
if (!caps.length) r.step("7.5a-agent-has-no-capabilities", "skip", { why: "the proof stopped before this step" });
else r.step("7.5a-agent-has-no-capabilities", caps.every(l => l.ok), { why: caps.map(l => `${l.ok ? "ok" : "FAIL"}: ${l.text}`).join("; ").slice(0, 400) });
const forge = lines.filter(l => l.tag === "4i");
if (!forge.length) r.step("7.5b-agent-cannot-forge-an-address", "skip", { why: "the proof stopped before this step" });
else r.step("7.5b-agent-cannot-forge-an-address", forge.every(l => l.ok), { why: forge.map(l => l.text).join("; ").slice(0, 400) });
const loop = lines.filter(l => l.tag === "4j");
if (!loop.length) r.step("7.5c-nothing-forwards-to-loopback", "skip", { why: "the proof stopped before this step" });
else r.step("7.5c-nothing-forwards-to-loopback", loop.every(l => l.ok), { why: loop.map(l => l.text).join("; ").slice(0, 300) });
const kill = lines.filter(l => l.tag === "4f");
for (const [i, step] of ["7.3a-killed-computer-reported-stopped", "7.3b-glass-says-so-plainly", "7.3c-nothing-left-running"].entries()) {
  const l = kill[i];
  if (!l) r.step(step, "skip", { why: "the proof stopped before this step" });
  else r.step(step, l.ok, { why: l.text.slice(0, 260) });
}
const left = spawnSync("docker", ["ps", "-a", "--filter", "name=csproof-", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim();
r.step("7.3d-no-leftover-containers", left === "", { why: left ? `left behind: ${left.replace(/\n/g, ", ")}` : "the proof's cleanup removed every container" });
r.step("7.6-windows-uia", "skip", { why: "not in 0.2 (rehearsal J7.6)" });
r.step("7.run", run.status === 0, { ms: Date.now() - t0, why: run.status === 0 ? undefined : run.status === 124 ? "the proof hung and was killed after 14 minutes; see j7-proof.log" : `proof exit ${run.status}` });
process.exit(r.failed ? 1 : 0);
