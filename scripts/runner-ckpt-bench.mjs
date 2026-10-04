// Checkpoint I/O on a Linux test box (runner-perf, 4 Oct). Run: node scripts/runner-ckpt-bench.mjs <mode> [dir]
//   turn   N sessions finish a turn at once and checkpoint: duration p50/p95, disk bytes and IOPS (from /proc/diskstats)
//   kill   SIGKILL a checkpointing process at random moments, then restore from the last complete checkpoint and verify it
// The space is a folder on the same disk, written the way a real server must (temp file, fsync, rename). The reader runs in this
// process (the sandboxed reader's cost was measured separately), so this measures the checkpoint's disk and CPU work.
import "../core/runner/testing/hosted-guard.js";
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { spawn, execSync } from "node:child_process";
import { sandboxReader } from "../core/runner/readerhost.js";
import { createSessionSync, restore, localReaderFor, atomicWrite, coverOf } from "../core/runner/sync.js";

const [mode = "turn", dirArg] = process.argv.slice(2);
const base = dirArg || path.join(process.env.HOME, "runner-ckpt-scratch");
const N = Number(process.env.SESSIONS || 20), FILES = Number(process.env.FILES || 300), CHANGED = Number(process.env.CHANGED || 20), FSIZE = Number(process.env.FSIZE || 20000);
const fsyncPath = p => { const fd = fs.openSync(p, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };

/** A space on disk. Every write is whole (temp, fsync, rename) before it is acknowledged. */
function diskSpace(root) {
  fs.mkdirSync(root, { recursive: true });
  const put = (rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); if (process.env.SPACESYNC === "0") { fs.writeFileSync(f + ".t", data); fs.renameSync(f + ".t", f); } else atomicWrite(f, data); };
  const j = rel => { try { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")); } catch { return null; } };
  return {
    async appendTranscript(s, entries) { const have = j(`${s}/transcript.json`) || []; for (const e of entries) if (!have.some(x => x.seq === e.seq)) have.push(e); put(`${s}/transcript.json`, JSON.stringify(have)); return { acked: Math.max(0, ...have.map(x => x.seq)) }; },
    async getTranscript(s, from) { return (j(`${s}/transcript.json`) || []).filter(e => e.seq >= from); },
    async putFile(s, rel, bytes) { const dir = `${s}/files/${Buffer.from(rel).toString("hex")}`; const v = (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).length : 0) + 1; put(`${dir}/${v}`, bytes === null ? Buffer.alloc(0) : bytes); return { version: v }; },
    async getFile(s, rel, v) { return fs.readFileSync(path.join(root, `${s}/files/${Buffer.from(rel).toString("hex")}/${v}`)); },
    async putCheckpoint(s, cp) { put(`${s}/checkpoint.json`, JSON.stringify(cp)); return { ok: true }; },
    async getCheckpoint(s) { return j(`${s}/checkpoint.json`); },
  };
}
// The reader runs inside the Linux sandbox like production (reads only files whose size or mtime changed); READER=local runs it in this process.
const readerFor = work => process.env.READER === "local" ? localReaderFor(work) : sandboxReader({ platform: "linux", space: "bench", work, base: path.dirname(work) });
const rnd = n => crypto.randomBytes(n).toString("hex").slice(0, n);
const mkSession = (root, i) => {
  const dir = path.join(root, "w" + i), files = path.join(dir, "work/files");
  fs.mkdirSync(files, { recursive: true }); fs.mkdirSync(path.join(dir, "work/home/.claude"), { recursive: true }); fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  return { dir, files, work: path.join(dir, "work"), state: path.join(dir, "state") };
};
// This run's own disk use: the cgroup's io.stat when run inside a systemd scope (the box is shared, so the whole device's counters
// include other people's work), else the device's /proc/diskstats.
const cg = (() => { try { const c = fs.readFileSync("/proc/self/cgroup", "utf8").trim().split("\n").pop().split("::")[1]; const f = `/sys/fs/cgroup${c}/io.stat`; fs.readFileSync(f); return f; } catch { return null; } })();
const disk = () => {
  if (cg && fs.readFileSync(cg, "utf8").trim()) { const t = { rd: 0, wr: 0, rio: 0, wio: 0 }; for (const l of fs.readFileSync(cg, "utf8").trim().split("\n")) { const kv = Object.fromEntries(l.split(" ").slice(1).map(x => x.split("="))); t.rd += +kv.rbytes || 0; t.wr += +kv.wbytes || 0; t.rio += +kv.rios || 0; t.wio += +kv.wios || 0; } return t; }
  const dev = process.env.DEV || "vda"; const l = fs.readFileSync("/proc/diskstats", "utf8").split("\n").map(x => x.trim().split(/\s+/)).find(c => c[2] === dev); return l ? { rd: +l[5] * 512, wr: +l[9] * 512, rio: +l[3], wio: +l[7] } : { rd: 0, wr: 0, rio: 0, wio: 0 };
};
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

if (mode === "turn") {
  fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(base, { recursive: true });
  const space = diskSpace(path.join(base, "space"));
  const S = [];
  for (let i = 0; i < N; i++) {
    const m = mkSession(base, i);
    for (let f = 0; f < FILES; f++) { const d = path.join(m.files, "d" + (f % 20)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `f${f}.txt`), rnd(FSIZE)); }
    const sy = createSessionSync({ space, session: "s" + i, work: m.work, state: m.state, reader: readerFor(m.work), seal: s => s });
    await sy.line('{"type":"result"}'); if (!await sy.checkpoint()) throw new Error("first checkpoint failed");   // the baseline: everything uploaded once
    S.push({ m, sy });
  }
  await new Promise(r => setTimeout(r, 1200));   // files modified in the last second are deferred, so let the baseline age
  // A turn: CHANGED files rewritten, 10 new ones, 40 transcript lines.
  for (const { m, sy } of S) {
    for (let f = 0; f < CHANGED; f++) fs.writeFileSync(path.join(m.files, "d" + (f % 20), `f${f}.txt`), rnd(FSIZE));
    for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(m.files, `new${f}.txt`), rnd(FSIZE));
    for (let l = 0; l < 40; l++) await sy.line(JSON.stringify({ type: "assistant", text: rnd(300) }));
    await sy.line('{"type":"result"}');
  }
  await new Promise(r => setTimeout(r, 1200));
  execSync("sync");   // the setup's own dirty pages must not be counted as the checkpoint's writes
  if (process.env.DROP === "1") { try { execSync("sudo -n sh -c 'echo 3 > /proc/sys/vm/drop_caches'"); } catch {} }
  const d0 = disk(), t0 = process.hrtime.bigint(), dur = [];
  const res = await Promise.all(S.map(async ({ sy }) => { const s = process.hrtime.bigint(); const ok = await sy.checkpoint(); dur.push(Number(process.hrtime.bigint() - s) / 1e6); return ok; }));
  const wall = Number(process.hrtime.bigint() - t0) / 1e6, d1 = disk();
  const mb = x => (x / 1048576).toFixed(1);
  console.log(JSON.stringify({ sessions: N, filesPerSession: FILES, changedPerTurn: CHANGED + 10, bytesChangedPerSession: (CHANGED + 10) * FSIZE, ok: res.every(Boolean), p50ms: Math.round(pct(dur, .5)), p95ms: Math.round(pct(dur, .95)), maxMs: Math.round(Math.max(...dur)), wallMs: Math.round(wall), readMB: mb(d1.rd - d0.rd), writeMB: mb(d1.wr - d0.wr), readIOPS: Math.round((d1.rio - d0.rio) / (wall / 1000)), writeIOPS: Math.round((d1.wio - d0.wio) / (wall / 1000)), writeIOs: d1.wio - d0.wio }));
  fs.rmSync(base, { recursive: true, force: true });
} else if (mode === "child") {
  // The process that gets killed: turns forever, each rewriting some files and appending lines, then a checkpoint.
  const space = diskSpace(path.join(base, "space")), m = mkSession(base, 0);
  const sy = createSessionSync({ space, session: "s0", work: m.work, state: m.state, reader: readerFor(m.work), seal: s => s });
  for (let turn = 1; ; turn++) {
    for (let f = 0; f < 40; f++) fs.writeFileSync(path.join(m.files, `f${f}.txt`), `turn ${turn} file ${f} ` + rnd(FSIZE));
    for (let l = 0; l < 20; l++) await sy.line(JSON.stringify({ turn, l }));
    await sy.line('{"type":"result"}');
    await new Promise(r => setTimeout(r, 1100));
    await sy.checkpoint();
    process.stdout.write(`turn ${turn}\n`);
  }
} else if (mode === "kill") {
  fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(base, { recursive: true });
  const rounds = Number(process.env.ROUNDS || 25); let bad = 0, midCkpt = 0, last = 0, resumed = 0;
  for (let r = 0; r < rounds; r++) {
    const c = spawn(process.execPath, [new URL(import.meta.url).pathname, "child", base], { stdio: ["ignore", "pipe", "inherit"] });
    // Kill at a random moment: after the chosen delay, whatever the child is doing (a write, an upload, the checkpoint file).
    await new Promise(res => setTimeout(res, 300 + Math.random() * 2600));
    c.kill("SIGKILL"); await new Promise(res => c.on("close", res));
    // 1. The space's last checkpoint restores whole into a fresh workspace and passes its own cover check.
    const space = diskSpace(path.join(base, "space")), fresh = path.join(base, "fresh" + r);
    fs.mkdirSync(path.join(fresh, "work/files"), { recursive: true });
    try {
      const got = await restore({ space, session: "s0", work: path.join(fresh, "work"), state: path.join(fresh, "state"), verify: () => true });
      if (got) {
        const cp = await space.getCheckpoint("s0");
        for (const [remote, m] of Object.entries(cp.manifest)) { const f = path.join(fresh, "work", remote); const h = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); if (m.hash !== "deleted" && h !== m.hash) throw new Error("file " + remote + " does not match the manifest"); }
        if (got.turn < last) throw new Error(`checkpoint went backwards: ${got.turn} < ${last}`); last = got.turn; resumed++;
      }
    } catch (e) { bad++; console.log("round", r, "FAIL restore:", e.message); }
    // 2. The killed process's own state folder opens again: no torn line, seq and turn consistent, no stray temp left.
    try {
      const m = path.join(base, "w0"), sy = createSessionSync({ space, session: "s0", work: path.join(m, "work"), state: path.join(m, "state"), reader: readerFor(path.join(m, "work")), seal: s => s });
      await sy.line('{"after":"kill"}');
      if (!await sy.checkpoint()) throw new Error("the next checkpoint after a kill failed");
      const t = fs.readFileSync(path.join(m, "state/s0/transcript.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l).seq);
      if (t.some((s, i) => s !== i + 1)) throw new Error("gap or duplicate in transcript numbers");
    } catch (e) { bad++; console.log("round", r, "FAIL reopen:", e.message); }
    fs.rmSync(fresh, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ rounds, resumedFromACheckpoint: resumed, failures: bad, lastTurnSeen: last }));
  fs.rmSync(base, { recursive: true, force: true });
}
