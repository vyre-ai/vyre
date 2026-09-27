// @ts-check
// perf-check --first-run: what the first index of someone's whole history costs the machine.
//
// A first `vyre up` on a Mac with years of Claude Code history held about 500% CPU for minutes
// while Recall embedded it, and the machine glitched. This measures that path: a real vyred on a
// temp home, the synthetic corpus plus the fixtures, vectors on, and the search model in its own
// process. By default the model is the fake from core/recall/testing.js burning 11 ms of CPU a
// call (what the real one costs a turn, embed.js), so the check is offline and deterministic;
// --real-model downloads and runs the real one.
//
// It samples vyred and every process under it (the model's) for `seconds` from start, and
// passes when their CPU together averages under one core, the model's process runs at nice 19,
// and keyword search answers while the vectors are still coming in.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Total CPU seconds of a process, from `ps -o time=`. */
function cpuOf(pid) {
  const r = spawnSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" });
  const s = (r.stdout || "").trim();
  return s ? s.split(":").map(Number).reduce((a, p) => a * 60 + p, 0) : null;
}
/** The pids directly under `pid`. */
function childrenOf(pid) {
  const r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  return (r.stdout || "").split("\n").map(Number).filter(Boolean);
}
function niceOf(pid) {
  const r = spawnSync("ps", ["-o", "ni=", "-p", String(pid)], { encoding: "utf8" });
  return Number((r.stdout || "").trim());
}

/**
 * @param {{ repo: string, log: (m: string) => void, seconds?: number, real?: boolean }} o
 * @returns {Promise<number>} exit code
 */
export async function firstRun({ repo, log, seconds = 60, real = false }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-first-run-"));
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  try {
    const dir = path.join(home, "transcripts");
    const { writeTranscripts } = await import(path.join(repo, "test", "fixtures", "corpus.js"));
    const { writeSyntheticCorpus } = await import(path.join(repo, "scripts", "lib", "perf-corpus.mjs"));
    writeTranscripts(dir);
    const synth = writeSyntheticCorpus(dir, { sessions: 250, turnsPerSession: 80, projects: 25 });
    const runtime = path.join(home, "embedder");
    const env = { ...process.env, VYRE_HOME: home, VYRE_NO_DIALOGS: "1", VYRE_TAILSCALE_BIN: path.join(home, "no-tailscale") };
    if (!real) {
      const { fakeNpm } = await import(path.join(repo, "core", "recall", "testing.js"));
      const { install } = await import(path.join(repo, "core", "recall", "embed.js"));
      const r = await install(runtime, { npm: fakeNpm(home) });
      if (r.why) throw new Error(r.why);
      env.FAKE_EMBED_SPIN_MS = "11";
    }
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
      transcripts: [dir], vault: { keystore: "file" },
      recall: { models: path.join(home, "models"), embedder: runtime, download: real },
    }));
    log(`first run: ${synth.sessions} synthetic sessions, ${synth.turns} turns, ${real ? "the real model" : "the fake model at 11 ms a call"}`);
    child = spawn(process.execPath, [path.join(repo, "core", "daemon", "main.js")], { env, stdio: "ignore" });
    const { call } = await import(path.join(repo, "core", "daemon", "client.js"));
    const t0 = Date.now();
    let last = { at: t0, cpu: new Map() };
    let cpuSec = 0, niceWorker = null, keywordOk = false, st = null;
    while (Date.now() - t0 < seconds * 1000) {
      await sleep(2000);
      const pids = [/** @type {number} */ (child.pid), ...childrenOf(/** @type {number} */ (child.pid))];
      for (const pid of pids) {
        const c = cpuOf(pid);
        if (c === null) continue;
        cpuSec += Math.max(0, c - (last.cpu.get(pid) ?? 0));
        last.cpu.set(pid, c);
        if (pid !== child.pid) niceWorker = niceOf(pid);
      }
      const s = await call("recall.status", {}, { root: home, timeout: 3000 });
      if (!s.error) st = s.data;
      if (!keywordOk && st && st.turns) {
        const q = await call("recall.search", { q: "intake form", limit: 3 }, { root: home, timeout: 3000 });
        keywordOk = !q.error && Array.isArray(q.data) && q.data.length > 0;
      }
    }
    const wall = (Date.now() - t0) / 1000;
    const cores = cpuSec / wall;
    const rows = [
      { name: "vyred + model, mean cores", value: cores.toFixed(2), budget: "< 1.00", pass: cores < 1 },
      { name: "model process nice", value: String(niceWorker), budget: "19", pass: niceWorker === 19 },
      { name: "keyword search while indexing", value: keywordOk ? "answers" : "no answer", budget: "answers", pass: keywordOk },
    ];
    process.stdout.write(`\n  first-run index, ${wall.toFixed(0)} s from start\n`);
    for (const r of rows) process.stdout.write(`    ${r.pass ? "ok  " : "FAIL"} ${r.name.padEnd(32)} ${r.value.padStart(10)}   budget ${r.budget}\n`);
    if (st) process.stdout.write(`    progress: ${st.progress?.sessions ? `${st.progress.sessions.done} of ${st.progress.sessions.total} sessions` : `${st.sessions} sessions`}, ` +
      `${st.vectors.embedded} of ${st.turns} turns embedded${st.progress?.paused ? ", paused: " + st.progress.paused : ""}\n\n`);
    return rows.every(r => r.pass) ? 0 : 1;
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await sleep(1500); if (child.exitCode === null) child.kill("SIGKILL"); }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
