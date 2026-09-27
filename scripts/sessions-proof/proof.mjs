// @ts-check
// ADR 0030 proof, run on testbox in a temp home. The real Agent SDK drives Vyre's fake
// `claude` (core/switchboard/testing/fake-claude.js), so no subscription is spent:
//   1. start a session, stream a turn
//   2. a Bash call goes through canUseTool into an ask; a "person" answers it
//   3. the floor denies a command without asking anyone
//   4. a question (AskUserQuestion) is answered with its answers
//   5. close, then resume the same session in a new query; the transcript grows in place
//   6. RSS and CPU of the host and of the child, active and idle
// Then (MODE=real-idle) the real bundled Claude Code binary is started with no credentials and
// no turn, only to measure what an idle owned session costs. It never calls the API.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSession } from "./claude-driver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(here, "../../core/switchboard/testing/fake-claude.js");
const home = fs.mkdtempSync(path.join(process.env.SCRATCH || os.tmpdir(), "vyre-sessions-proof-"));
const cwd = path.join(home, "project"); fs.mkdirSync(cwd);
const tx = path.join(home, "projects");
const log = path.join(home, "fake.log");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TICK = 100; // Linux clock ticks per second

/** RSS in MB and CPU seconds of one pid, from /proc. */
function stat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    const rss = Number(fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1] || 0) / 1024;
    return { rss: Math.round(rss), cpu: (Number(s[11]) + Number(s[12])) / TICK };
  } catch { return { rss: 0, cpu: 0 }; }
}
/** A pid and every descendant (the SDK's child and anything it starts). */
function tree(pid) {
  const all = [pid];
  for (const p of fs.readdirSync("/proc").filter(d => /^\d+$/.test(d))) {
    try { if (fs.readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" ")[1] === String(pid)) all.push(...tree(Number(p))); } catch {}
  }
  return all;
}
const sum = pids => pids.map(stat).reduce((a, b) => ({ rss: a.rss + b.rss, cpu: a.cpu + b.cpu }), { rss: 0, cpu: 0 });
/** CPU percent over a window, for the host and for the child tree. */
async function measure(s, ms) {
  const h0 = stat(process.pid), c0 = sum(tree(/** @type {number} */ (s.pid)));
  await sleep(ms);
  const h1 = stat(process.pid), c1 = sum(tree(/** @type {number} */ (s.pid)));
  const pct = (a, b) => +((100 * (b - a)) / (ms / 1000)).toFixed(2);
  return { host_rss_mb: h1.rss, host_cpu_pct: pct(h0.cpu, h1.cpu), child_rss_mb: c1.rss, child_cpu_pct: pct(c0.cpu, c1.cpu) };
}

const results = /** @type {Record<string, any>} */ ({});
const check = (name, ok, detail) => { results[name] = { ok: Boolean(ok), ...(detail ? { detail } : {}) }; console.log(ok ? "ok  " : "FAIL", name, detail ? JSON.stringify(detail) : ""); };

/** Wait for an event of a type (and a test), with a timeout. */
function next(s, type, test = () => true, ms = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${type}`)); }, ms);
    const off = s.subscribe(e => { if (e.type === type && test(e)) { clearTimeout(t); off(); resolve(e); } });
  });
}

const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_TRANSCRIPTS: tx };
delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_API_KEY; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;

// The floor, as the Harness's rules would run it, before anyone is asked.
const floor = (tool, input) => tool === "Bash" && /\brm\s+-rf\s+\/(\s|$)/.test(input?.command || "") ? { deny: "The floor refuses rm -rf /." } : null;

if (process.env.MODE !== "real-idle") {
  const id = crypto.randomUUID();
  const s = new ClaudeSession({ cwd, sessionId: id, bin: FAKE, env, floor, append: "Your name is juno. You work for alex." });
  /** @type {any[]} */ const events = [];
  s.subscribe(e => events.push(e));

  // A "person" on some surface: answers every permission ask with allow, every question with a choice.
  s.subscribe(e => {
    if (e.type !== "ask.raised") return;
    setTimeout(() => {
      if (e.ask.kind === "question") s.answer(e.ask.id, { decision: "allow", answers: Object.fromEntries(e.ask.input.questions.map(q => [q.question, q.options[0].label])) });
      else s.answer(e.ask.id, { decision: "allow" });
    }, 50);
  });

  const t0 = Date.now();
  s.send("hello from alex");
  await next(s, "turn.completed");
  const deltas = events.filter(e => e.type === "text.delta").map(e => e.text).join("");
  check("1 start and stream", deltas === "echo: hello from alex" && events.some(e => e.type === "session.started"), { deltas: events.filter(e => e.type === "text.delta").length, first_turn_ms: Date.now() - t0 });

  s.send("bash npm test");
  const raised = await next(s, "ask.raised");
  await next(s, "turn.completed");
  const answered = events.find(e => e.type === "ask.answered");
  check("2 permission through canUseTool into an ask", raised.ask.tool === "Bash" && answered?.decision === "allow" && events.some(e => e.type === "text.delta" && /Ran/.test(e.text)),
    { tool: raised.ask.tool, input: raised.ask.input.command });

  const before = events.filter(e => e.type === "ask.raised").length;
  s.send("bash rm -rf /");
  await next(s, "turn.completed");
  check("3 the floor denies without asking", events.filter(e => e.type === "ask.raised").length === before && events.some(e => e.type === "tool.denied" && e.by === "floor"));

  s.send("ask");
  const q = await next(s, "ask.raised", e => e.ask.kind === "question");
  const said = await next(s, "turn.completed");
  check("4 a question is answered", /Warm crust/.test(String(said.result)), { questions: q.ask.input.questions.length });

  // Queue while a turn runs: the second message waits for the first.
  s.send("bash sleep");
  s.send("queued words");
  await next(s, "turn.completed", e => /echo: queued words/.test(String(e.result)), 15000).then(() => check("5 a message sent mid-turn is queued, then runs", events.some(e => e.type === "turn.queued")),
    err => check("5 a message sent mid-turn is queued, then runs", false, { err: err.message }));

  results.active = await measure(s, 2000);
  results.idle = await measure(s, 30000);
  results.child_pid_known = Boolean(s.pid);
  await s.close();

  // Resume in a new query: same id, --resume passed, the transcript grows in place.
  const file = path.join(tx, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").length;
  const r = new ClaudeSession({ cwd, resume: id, bin: FAKE, env, floor });
  r.send("again");
  const done = await next(r, "turn.completed");
  await r.close();
  const after = fs.readFileSync(file, "utf8").trim().split("\n").length;
  const argv = fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l).argv);
  check("6 resume in a new query", /echo: again/.test(String(done.result)) && after > lines && argv[1].some(a => a === `--resume=${id}` || a === "--resume"),
    { transcript_lines: [lines, after] });
  results.sdk_argv = { start: argv[0], resume: argv[1] };
} else {
  // The real bundled Claude Code, no credentials, no turn: what one idle owned session costs.
  const s = new ClaudeSession({ cwd, env: { ...env, FAKE_CLAUDE_LOG: undefined, FAKE_CLAUDE_TRANSCRIPTS: undefined }, settingSources: [] });
  const init = s.q.initializationResult().then(() => "initialized", e => `init error: ${e.message}`);
  const t0 = Date.now();
  results.init = await Promise.race([init, sleep(20000).then(() => "no init in 20 s")]);
  results.init_ms = Date.now() - t0;
  await sleep(3000);
  results.real_idle = await measure(s, 30000);
  results.real_child = path.basename(String(fs.readlinkSync(`/proc/${s.pid}/exe`)));
  await s.close();
}

fs.writeFileSync(path.join(process.env.OUT || home, `proof-${process.env.MODE || "fake"}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
fs.rmSync(home, { recursive: true, force: true });
process.exit(Object.values(results).some(v => v && v.ok === false) ? 1 : 0);
