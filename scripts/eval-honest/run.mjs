// @ts-check
// eval-honest runner (R031-00v): Eval A (plain Claude Code against Claude Code with Vyre) and Eval B (memory across a forced roll), on the seeded world of scripts/token-proof-world.mjs.
// Started through scripts/eval-honest.mjs, which hands over to `token-proof-world.mjs eval`. Rules (scripts/lib/eval-honest.js has the pure parts):
//   pre-registered and sealed; verified against the world (no model judges); fresh-thread, process-count and model guards; seeded interleaved order; at least 3 reps; every run reported;
//   the world reset between runs is READ BACK and a non-empty read-back stops the run; held-out tasks run in their own group; spend capped.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseStream } from "../lib/token-proof.js";
import { sealOf, plan, lint, CHECKS, B_CHECKS, outcomeOf, guards, compactedIn, initsOf, report, endedRow, keyOf, attemptsMade, authProblems, authCheck, KEY } from "../lib/eval-honest.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

/** The Vyre arm's environment: the shipped default listing (core tools plus tools_run), Claude Code's own tool search off, as in the token-proof rounds. */
const VYRE_ENV = { VYRE_MCP_LISTING: "", ENABLE_TOOL_SEARCH: "false", VYRE_MCP_FEATURES: "run" };

/** @param {string} cmd @param {string[]} a */
const git = (cmd, a) => spawnSync("git", [cmd, ...a], { cwd: ROOT, encoding: "utf8" }).stdout.trim();

/** The sealed pre-registration, read as written. @returns {{ prereg: any, heldout: any, seal: string, sealed: string }} */
export function loadSealed() {
  const pr = fs.readFileSync(path.join(HERE, "prereg.json"), "utf8"), ho = fs.readFileSync(path.join(HERE, "heldout.json"), "utf8");
  const sealed = fs.existsSync(path.join(HERE, "PREREG.sha256")) ? fs.readFileSync(path.join(HERE, "PREREG.sha256"), "utf8").trim() : "";
  return { prereg: JSON.parse(pr), heldout: JSON.parse(ho), seal: sealOf(pr, ho), sealed };
}

/** @param {any} ctx */
export async function evalMain(ctx) {
  const { args, flag, d, call, home, work, until, readRun, clearTodos, vendor, vendorPort, FAKE } = ctx;
  const standIn = args.includes("--stand-in"), checkOnly = args.includes("--check");
  const which = flag("which", "all");
  const fail = (/** @type {string} */ m) => { console.error(m); return 2; };

  // ---------------------------------------------------------------- the gate: sealed, clean, capped
  const { prereg, heldout, seal, sealed } = loadSealed();
  const sha = git("rev-parse", ["HEAD"]);
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "scripts", "core", "lib", "harness"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const paid = !standIn && !checkOnly;
  if (paid) {
    if (process.env.VYRE_PROOF_PAID !== "yes") return fail("refused: a paid run needs VYRE_PROOF_PAID=yes (the product owner's go)");
    if (!(Number(flag("max-usd")) > 0)) return fail("refused: --max-usd is required");
    const noAuth = authProblems(process.env);
    if (noAuth.length) return fail(`refused: ${noAuth.join("; ")}`);
    if (seal !== sealed) return fail(`refused: the pre-registration differs from PREREG.sha256 (now ${seal.slice(0, 16)}, sealed ${sealed.slice(0, 16) || "none"}); a changed prereg is a new experiment: seal it again and say why`);
    if (dirty) return fail(`refused: uncommitted changes under scripts/ core/ lib/ harness/ (the runs record the tree sha, so the tree must be a commit):\n${dirty.slice(0, 600)}`);
  }
  const model = flag("model", prereg.model);
  const cap = paid ? Number(flag("max-usd")) : Infinity;
  const out = flag("out", fs.mkdtempSync(`${home}-honest-`));
  fs.mkdirSync(out, { recursive: true });
  const rowsFile = path.join(out, "rows.json");
  // A heartbeat the front door's supervisor watches (scripts/eval-honest.mjs): if this process stops beating (its event loop is blocked), the supervisor takes a diagnostic report and ends it. A loop that
  // lags more than 30 s is also said aloud, with how long, so a stall leaves a trace even when it clears.
  let phase = "starting";
  /** The run in flight, so a supervisor that ends a stalled harness can record that run as invalid. @type {{ name: string, rep: number, n: number } | null} */
  let current = null;
  const beat = () => { try { fs.writeFileSync(path.join(out, ".heartbeat"), JSON.stringify({ at: Date.now(), phase, job: current, sha })); } catch { /* the folder is gone */ } };
  beat();
  let lastTick = Date.now();
  setInterval(() => { const now = Date.now(); if (now - lastTick > 30_000) console.error(`WARNING: the harness event loop was blocked for ${Math.round((now - lastTick) / 1000)} s`); lastTick = now; beat(); }, 5000).unref();
  const RUN_CAP_MS = Number(flag("run-cap-min", "10")) * 60_000;
  if (flag("disclose")) { const f = path.join(out, "disclosures.json"); const had = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []; fs.writeFileSync(f, JSON.stringify([...had, flag("disclose")], null, 1)); }
  /** The claude children of plain runs in flight, so a run that times out can end its own. @type {Set<import("node:child_process").ChildProcess>} */
  const plainKids = new Set();
  if (fs.existsSync(rowsFile) && !args.includes("--again")) return fail(`refused: ${out} already holds rows.json; use a fresh --out, or --again to add to it`);
  const lock = path.join(out, ".eval.lock");
  try { const pid = Number(fs.readFileSync(lock, "utf8")); if (pid && pid !== process.pid) { try { process.kill(pid, 0); return fail(`refused: another eval (pid ${pid}) is writing to ${out}`); } catch { /* stale */ } } } catch { /* none */ }
  fs.writeFileSync(lock, String(process.pid));
  process.on("exit", () => { try { fs.rmSync(lock, { force: true }); } catch { /* gone */ } });
  if (model) process.env.ANTHROPIC_MODEL = model;

  // lint: no question carries an answer
  const msgs = prereg.evalB.messages;
  const lintBad = lint(msgs, msgs.map((/** @type {any} */ m, /** @type {number} */ i) => ({ m, i })).filter((/** @type {any} */ o) => o.m.kind === "question").map((/** @type {any} */ o) => ({ index: o.i, answers: o.m.answers.filter((/** @type {string} */ a) => !a.startsWith("{")) })));
  if (lintBad.length) return fail(`refused: the scripted conversation leaks answers:\n${lintBad.join("\n")}`);

  // ---------------------------------------------------------------- the world's own state, for resets and evidence
  const items = async () => { const l = await call("planner.list", { state: "all", limit: 500 }); return (l.data && l.data.items) || (Array.isArray(l.data) ? l.data : []); };
  const todoNow = async () => { const it = await items(); return { titles: it.map((/** @type {any} */ x) => String(x.title)), ids: Object.fromEntries(it.map((/** @type {any} */ x) => [String(x.title), String(x.id)])) }; };
  const heldNow = async () => { const g = await call("gate.held", {}); const h = g.data && (Array.isArray(g.data.held) ? g.data.held : Array.isArray(g.data) ? g.data : []); return h || []; };
  const writesNow = async () => { const w = await call("memory.writes", { limit: 500 }); return (w.data && Array.isArray(w.data.writes) ? w.data.writes : []).filter((/** @type {any} */ x) => x && x.state !== "forgotten"); };
  const seedWrites = new Set((await writesNow()).map((/** @type {any} */ x) => String(x.id)));
  const northwind = path.join(work, "northwind");
  const SEED_FILES = new Set(["engagement-letter.txt"]);
  const clientIds = async (/** @type {RegExp} */ re) => {
    const r = await call("records.list", { type: "client", limit: 1000 });
    /** @type {{ id: string, name: string }[]} */ const found = [];
    const walk = (/** @type {any} */ v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { const name = v.data && v.data.name !== undefined ? v.data.name : v.name; if (v.id && typeof name === "string") found.push({ id: String(v.id), name }); for (const k of Object.keys(v)) if (v[k] && typeof v[k] === "object") walk(v[k]); } };
    walk(r.data);
    const seen = new Map(found.map((x) => [x.id, x]));
    return [...seen.values()].filter((x) => re.test(x.name));
  };

  /** Everything a run could leave, cleared, then READ BACK. Returns the leftovers; a non-empty answer stops the run. @param {string} tagRe */
  async function resetWorld(tagRe = "^Z[a-z0-9]{4} (One|Two|Three)$") {
    const left = [];
    await call("agents.stop", { agent: "juno" });
    const teammate = ctx.teammateAgent(); if (teammate) await call("agents.stop", { agent: teammate });
    for (const th of ((await call("agents.threads", { agent: "juno" })).data || []).map((/** @type {any} */ x) => x.id || x.thread)) if (th) await call("threads.delete", { thread: th });
    await clearTodos();
    for (const h of await heldNow()) await call("gate.reject", { id: h.id, reason: "eval reset" });
    for (const w of await writesNow()) if (!seedWrites.has(String(w.id))) await call("memory.write.forget", { id: w.id });
    for (const c of await clientIds(new RegExp(tagRe))) { const r = await call("records.forget", { type: "client", id: c.id }); if (r.error) await call("records.forget", { id: c.id }); }
    fs.mkdirSync(northwind, { recursive: true });
    for (const f of fs.readdirSync(northwind)) if (!SEED_FILES.has(f)) fs.rmSync(path.join(northwind, f), { recursive: true, force: true });
    await vendor.reset();
    // the read-back
    const t = await todoNow(); if (t.titles.length) left.push(`${t.titles.length} todos`);
    const h = await heldNow(); if (h.length) left.push(`${h.length} held items`);
    const w = (await writesNow()).filter((/** @type {any} */ x) => !seedWrites.has(String(x.id))); if (w.length) left.push(`${w.length} memory writes`);
    const c = await clientIds(new RegExp(tagRe)); if (c.length) left.push(`${c.length} eval clients`);
    const fs2 = fs.readdirSync(northwind).filter((f) => !SEED_FILES.has(f)); if (fs2.length) left.push(`${fs2.length} files in northwind`);
    if ((await vendor.hits()).length) left.push("vendor log not empty");
    const threads = ((await call("agents.threads", { agent: "juno" })).data || []); if (threads.length) left.push(`${threads.length} threads`);
    return left;
  }

  // `--prove-reset`: make what a run could leave (a todo, a client, a memory write, a file, a vendor hit), reset, and show the read-back. Free; the proof that the reset works before it is trusted.
  if (args.includes("--prove-reset")) {
    await call("planner.add", { kind: "todo", title: "Call Test Person" });
    const made = await call("records.create", { type: "client", data: { name: "Zab12 One", case_type: "probate" } });
    const mem = await call("memory.write", { kind: "fact", text: "eval reset probe fact", project: "northwind" });
    fs.writeFileSync(path.join(northwind, "stray.txt"), "left by a run");
    await vendor.push("GET /v1/status");
    console.log(`made: client ${made.error ? "ERROR " + made.error.message : "ok"}, memory write ${mem.error ? "ERROR " + mem.error.message : "ok"}`);
    const left = await resetWorld();
    console.log(`reset read-back: ${left.length ? "LEFT " + left.join(", ") : "empty, as it must be"}`);
    return left.length ? 1 : 0;
  }

  // `--probe-held`: does the Eval B note (a POST with the stored Acme key) come back held, as a Vyre agent would see it? Free: the call is made through the agent's own socket, no model.
  if (args.includes("--probe-held")) {
    const r = await ctx.viaSession("juno", "vault.request", { credential: "acme", method: "POST", url: "https://api.acme-proof.test/v1/notes", body: JSON.stringify({ text: "retainer ready" }), headers: { "content-type": "application/json" } });
    console.log(`held probe: ${JSON.stringify(r).slice(0, 400)}`);
    console.log(`vendor saw: ${JSON.stringify(await vendor.hits())}; held items now: ${(await heldNow()).length}`);
    return 0;
  }

  // ---------------------------------------------------------------- one claude run on a plain arm (no Vyre: an empty config folder, no MCP)
  /** @param {{ prompt: string, cwd: string, env: Record<string, string>, tee: string }} o @returns {Promise<string>} the stream */
  function runPlain({ prompt, cwd, env, tee }) {
    return new Promise((resolve) => {
      const bin = standIn ? FAKE : flag("claude", "claude");
      const cfg = fs.mkdtempSync(path.join(path.dirname(out), "plain-config-"));
      const argv = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...(model ? ["--model", model] : []), "--permission-mode", "acceptEdits",
        "--allowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "--strict-mcp-config"];
      const child = spawn(bin, argv, { cwd, env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: cfg }, stdio: ["pipe", "pipe", "ignore"] });
      plainKids.add(child);
      let buf = "";
      child.stdout.on("data", (/** @type {Buffer} */ b) => { buf += b; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
      child.on("close", () => { plainKids.delete(child); clearTimeout(timer); fs.writeFileSync(tee, buf); fs.rmSync(cfg, { recursive: true, force: true }); resolve(buf); });
      // The stand-in names its model only after an initialize request (a real claude does it by itself on the first message): the plumbing check sends one so the model and process guards see what they would.
      if (standIn) child.stdin.write(JSON.stringify({ type: "control_request", request_id: "i1", request: { subtype: "initialize" } }) + "\n");
      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } }) + "\n");
      child.stdin.end();
    });
  }

  /** The data a plain arm in A2 is given: the world as a person without Vyre would have it. @param {string} dir */
  async function plainWorld(dir) {
    const { worldData } = await import("../lib/eval-honest.js");
    const w = worldData();
    fs.writeFileSync(path.join(dir, "clients.json"), JSON.stringify(w.clients.map((c) => ({ name: c.name, case_type: c.case_type })), null, 1));
    fs.writeFileSync(path.join(dir, "matters.json"), JSON.stringify(w.matters.map((m) => ({ title: m.title, stage: m.stage, client: m.client })), null, 1));
    fs.writeFileSync(path.join(dir, "notes.md"), "# Notes\n\nHarlow Legal pays a monthly retainer of $4,200.\n");
    fs.writeFileSync(path.join(dir, "todo.txt"), "");
    fs.mkdirSync(path.join(dir, "northwind"), { recursive: true });
    fs.copyFileSync(path.join(northwind, "engagement-letter.txt"), path.join(dir, "northwind", "engagement-letter.txt"));
  }

  // ---------------------------------------------------------------- the rows
  /** @type {any[]} */ const rows = fs.existsSync(rowsFile) ? JSON.parse(fs.readFileSync(rowsFile, "utf8")) : [];
  let spent = rows.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + (r.usd || 0), 0);
  const save = () => fs.writeFileSync(rowsFile, JSON.stringify(rows, null, 1));
  const usageOf = (/** @type {string[]} */ parts) => {
    const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; let usd = 0, ms = 0, turns = 0, calls = 0;
    for (const p of parts) { const r = parseStream(p); u.input += r.usage.input; u.output += r.usage.output; u.cacheRead += r.usage.cacheRead; u.cacheWrite += r.usage.cacheWrite; usd += r.usd; ms += r.ms; turns += r.turns; calls += r.calls.length; }
    return { usage: u, usd, ms, turns, calls };
  };
  const line = (/** @type {any} */ r) => `${String(r.n).padStart(3)} ${r.cell.padEnd(11)} ${r.task.padEnd(10)} rep${r.rep} ${r.valid ? r.outcome.toUpperCase().padEnd(8) : "INVALID ".padEnd(8)} ${r.valid ? "" : (r.invalid || []).join("; ")} $${r.usd.toFixed(3)} ${Math.round(r.ms / 1000)}s`;

  // ---------------------------------------------------------------- the world values the checks need, computed before any run
  const expectA = {};
  { const dj = JSON.stringify((await call("docs.find", { query: "pair a phone" })).data || ""); const m = dj.match(/[\w\-./]+\.md/); expectA.docPath = m ? m[0] : "";
    const sj = JSON.stringify((await call("skills.find", { query: "keep a password out of a file" })).data || ""); const k = sj.match(/vyre\/[\w.-]+/); expectA.skillId = k ? k[0] : ""; }
  console.log(`seal ${seal.slice(0, 16)} ${sealed === seal ? "(matches PREREG.sha256)" : "(NOT sealed)"}; tree ${sha.slice(0, 9)}${dirty ? " (dirty)" : ""}; model ${model || "default"}; expected values: docs ${expectA.docPath || "?"}, skill ${expectA.skillId || "?"}`);

  // ================================================================ Eval A
  /** One Eval A run. @param {{ task: any, arm: string, group: string, rep: number, n: number, retryOf?: number|null }} u */
  async function runA(u) {
    const { task, arm } = u;
    phase = `run ${u.n} (A ${task.id}/${arm}): resetting the world`;
    const left = await resetWorld(); if (left.length) throw new Error(`the world was not reset before run ${u.n}: ${left.join(", ")}`);
    phase = `run ${u.n} (A ${task.id}/${arm}): the model is working`;
    const tee = path.join(out, `A-${u.n}-${task.id}-${arm}.jsonl`);
    const t0 = Date.now();
    /** @type {string} */ let stream = ""; let plain = arm !== "vyre"; let todos = (await todoNow());
    /** @type {string[]} */ let invalid = [];
    if (arm === "vyre") {
      Object.assign(process.env, VYRE_ENV); if (!process.env.VYRE_MCP_LISTING) delete process.env.VYRE_MCP_LISTING;
      process.env.TOKEN_PROOF_TEE = tee;
      const asked = await call("agents.ask", { agent: "juno", text: task.prompt, wait: true, surface: "deck" });
      await until(async () => !(await call("threads.asks", {})).data?.length && /"type":"result"/.test(readRun(tee)), `the end of ${task.id}`, 600_000).catch(() => null);
      stream = readRun(tee);
      if (asked.error) invalid.push(`agents.ask failed: ${asked.error.message}`);
      todos = await todoNow();
    } else {
      const dir = fs.mkdtempSync(path.join(out, `plain-${u.n}-`));
      const env = /** @type {Record<string, string>} */ ({});
      if (arm === "plain-a2") { await plainWorld(dir); Object.assign(env, { ACME_BASE: `http://127.0.0.1:${vendorPort}`, ACME_KEY: KEY, ORBIT_BASE: `http://127.0.0.1:${vendorPort}`, ORBIT_KEY: KEY }); }
      stream = await runPlain({ prompt: arm === "plain-a2" ? task.plain : task.prompt, cwd: dir, env, tee });
      const tf = path.join(dir, "todo.txt");
      todos = arm === "plain-a2" && fs.existsSync(tf) ? { titles: fs.readFileSync(tf, "utf8").split("\n").map((l) => l.trim()).filter(Boolean), ids: Object.fromEntries(fs.readFileSync(tf, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const m = l.match(/^(\S+)\s*\|\s*(.+)$/); return m ? [m[2].trim(), m[1]] : [l, l]; })) } : { titles: [], ids: {} };
      if (arm === "plain-a2" && task.check === "heldout_todo") todos.titles = todos.titles.map((t) => t.replace(/^\S+\s*\|\s*/, ""));
    }
    phase = `run ${u.n} (A ${task.id}/${arm}): checking the answer`;
    const run = parseStream(stream);
    const { model: seen, models } = initsOf(stream);
    const processes = arm === "vyre" ? readRun(tee, true).length : 1;
    const fresh = !/SessionStart:resume/.test(stream);
    invalid.push(...guards({ fresh, processes, model: seen, models }, { model: standIn ? "" : model, processes: arm === "vyre" ? [1, 2] : 1 }));
    if (!run.text.trim() && !standIn) invalid.push("the run ended with no answer text");
    const verdict = CHECKS[task.check]({ text: run.text, calls: run.calls, todos: todos.titles, todoIds: todos.ids, hits: await vendor.hits(), expect: expectA });
    // a task with no plain equivalent is measured as given, not given invented data
    const outcome = outcomeOf(verdict, run.text, plain);
    const u2 = usageOf([stream]);
    const row = { eval: "A", cell: arm, task: task.id, group: u.group, rep: u.rep, n: u.n, valid: invalid.length === 0, invalid, outcome, why: verdict.why, retryOf: u.retryOf || null, ...u2, ms: u2.ms || Date.now() - t0, sha, stream: path.basename(tee), needsVyre: Boolean(task.needsVyre) };
    return row;
  }

  // ================================================================ Eval B
  /** One Eval B run: nine messages, the same words in every arm, a roll after the fifth. @param {{ arm: any, rep: number, n: number, retryOf?: number|null }} u */
  async function runB(u) {
    const left = await resetWorld(); if (left.length) throw new Error(`the world was not reset before run ${u.n}: ${left.join(", ")}`);
    const arm = u.arm, B = prereg.evalB;
    const tag = "Z" + crypto.createHash("sha256").update(`${prereg.orderSeed}:${u.n}`).digest("hex").slice(0, 4).replace(/[^a-z0-9]/g, "a");
    for (const [name, body] of Object.entries(B.files)) fs.writeFileSync(path.join(northwind, name), String(body));
    Object.assign(process.env, VYRE_ENV, arm.env); if (!process.env.VYRE_MCP_LISTING) delete process.env.VYRE_MCP_LISTING;
    await call("settings.set", { key: "sessions.rollover", value: Boolean(arm.rollover) });
    const tee = path.join(out, `B-${u.n}-${arm.id}.jsonl`); process.env.TOKEN_PROOF_TEE = tee;
    const sub = (/** @type {string} */ s, /** @type {Record<string, string>} */ extra = {}) => s.replace(/\{tag\}/g, tag).replace(/\{(\w+)\}/g, (_m, k) => extra[k] ?? `{${k}}`);
    const resultsOf = () => { /** @type {string[]} */ const r = []; for (const l of readRun(tee).split("\n")) { try { const e = JSON.parse(l); if (e.type === "result") r.push(String(e.result || "")); } catch { /* not json */ } } return r; };
    /** @type {string[]} */ const invalid = []; /** @type {Record<string, string>} */ const answers = {}; /** @type {Record<string, any>} */ const verdicts = {};
    let thread = "";
    const ask = async (/** @type {string} */ text) => {
      const before = resultsOf().length;
      const r = await call("agents.ask", { agent: "juno", text, wait: true, surface: "deck" });
      if (r.error) { invalid.push(`agents.ask failed: ${r.error.message}`); return ""; }
      if (!thread) thread = (r.data && r.data.thread) || ((await call("agents.threads", { agent: "juno" })).data || [])[0]?.id || "";
      await until(async () => !(await call("threads.asks", {})).data?.length && resultsOf().length > before, `the answer to "${text.slice(0, 30)}"`, 600_000).catch(() => null);
      const rs = resultsOf(); return rs.length > before ? rs[rs.length - 1] : "";
    };
    let secondId = "";
    let rolled = null, compacted = null;
    for (const m of B.messages) {
      const text = sub(m.text, { secondId });
      answers[m.id] = await ask(text);
      if (m.id === B.rollAfter) {
        const ids = await clientIds(new RegExp(`^${tag} Two$`)); secondId = ids[0] ? ids[0].id : "";
        if (arm.roll === "vyre" && thread) { const r = await call("threads.roll", { thread }); if (r.error) invalid.push(`threads.roll failed: ${r.error.message}`); const rl = ((await call("threads.rolls", { thread })).data || {}); rolled = (Array.isArray(rl) ? rl : rl.rolls || []).length >= 1; }
        if (arm.roll === "compact") { await ask("/compact"); compacted = compactedIn(readRun(tee)); }
      }
    }
    const parts = readRun(tee, true);
    const stream = parts.join("");
    const { model: seen, models } = initsOf(stream);
    const processes = parts.length;
    const fresh = !/SessionStart:resume/.test(parts[0] || "");
    invalid.push(...guards({ fresh, processes, model: seen, models, rolled, compacted }, { model: standIn ? "" : model, processes: arm.processes, roll: arm.roll === "none" ? null : arm.roll }));
    const todos = await todoNow();
    for (const m of B.messages.filter((/** @type {any} */ x) => x.kind === "question")) verdicts[m.id] = B_CHECKS[m.check]({ text: answers[m.id] || "", calls: [], todos: todos.titles, hits: await vendor.hits(), expect: { secondId } });
    const failed = Object.entries(verdicts).filter(([, v]) => !v.pass).map(([k]) => k);
    const u2 = usageOf(parts);
    return { eval: "B", cell: arm.id, task: "memory", group: "", rep: u.rep, n: u.n, valid: invalid.length === 0, invalid, outcome: failed.length === 0 ? "pass" : "fail", why: failed.length ? `wrong: ${failed.join(", ")} (${Object.keys(verdicts).length - failed.length} of ${Object.keys(verdicts).length} right)` : "all four questions right", retryOf: u.retryOf || null, ...u2, sha, stream: path.basename(tee), questions: Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, v.pass])) };
  }

  // ================================================================ the plan and the loop
  /** @type {{ n: number, rep: number, run: (num: number) => Promise<any>, name: string, key: string }[]} */ const jobs = [];
  let n = rows.reduce((/** @type {number} */ m, /** @type {any} */ r) => Math.max(m, r.n), 0);
  /** A run keeps its number across a resume (the number its first attempt has in rows.json); a new one takes the next. @param {string} key */
  const numFor = (key) => { const r = rows.find((/** @type {any} */ x) => keyOf(x) === key && !x.retryOf); return r ? r.n : ++n; };
  if (which === "A" || which === "all") {
    const tasks = [...prereg.evalA.tasks.map((/** @type {any} */ t) => ({ ...t, group: "ten" })), ...heldout.tasks.map((/** @type {any} */ t) => ({ ...t, group: "held-out" }))];
    const only = flag("only") ? flag("only").split(",") : null;
    const cellsOnly = flag("cells") ? flag("cells").split(",") : null;
    const units = tasks.filter((t) => !only || only.includes(t.id)).flatMap((t) => prereg.evalA.cells.filter((/** @type {any} */ c) => !cellsOnly || cellsOnly.includes(c.id)).map((/** @type {any} */ c) => ({ id: `${t.id}/${c.id}`, task: t, arm: c.id })));
    const reps = Number(flag("reps", String(prereg.reps)));
    for (const p of plan({ orderSeed: prereg.orderSeed, reps }, units)) jobs.push({ ...((key) => ({ key, n: numFor(key) }))(keyOf({ eval: "A", task: p.cell.task.id, cell: p.cell.arm, rep: p.rep })), rep: p.rep, name: `A ${p.cell.id}`, run: (/** @type {number} */ num) => runA({ task: p.cell.task, arm: p.cell.arm, group: p.cell.task.group, rep: p.rep, n: num }) });
  }
  if (which === "B" || which === "all") {
    const reps = Number(flag("reps", String(prereg.reps)));
    const armsOnly = flag("arms") ? flag("arms").split(",") : null;
    for (const p of plan({ orderSeed: prereg.orderSeed + 1, reps }, prereg.evalB.arms.filter((/** @type {any} */ a) => !armsOnly || armsOnly.includes(a.id)))) jobs.push({ ...((key) => ({ key, n: numFor(key) }))(keyOf({ eval: "B", task: "memory", cell: p.cell.id, rep: p.rep })), rep: p.rep, name: `B ${p.cell.id}`, run: (/** @type {number} */ num) => runB({ arm: p.cell, rep: p.rep, n: num }) });
  }
  // `--first N`: only the first N runs of the plan (the proof of the stall supervisor uses the first 8 cells of Eval A on the stand-in).
  if (flag("first")) jobs.length = Math.min(jobs.length, Number(flag("first")));
  console.log(`${jobs.length} runs planned (${which}), order seed ${prereg.orderSeed}${paid ? `, cap $${cap}` : ", no cost"}`);
  if (args.includes("--plan")) { for (const j of jobs) console.log(`${j.n} rep${j.rep} ${j.name}`); return 0; }

  let stopped = false;
  // `--stall-proof [N]`: block this process's event loop on purpose as run N (default 1) starts, to prove the supervisor notices, takes the diagnostic report, records the run as invalid and ends the harness
  // (node scripts/eval-honest.mjs check --home <dir> --stall-proof 3 --stall-min 0.4); `--again` with the same --out then carries on from that run.
  const stallAt = args.includes("--stall-proof") ? Number(flag("stall-proof")) || 1 : 0;
  if (rows.length && args.includes("--again")) console.log(`resuming: ${rows.length} rows already in ${rowsFile}`);
  for (const j of jobs) {
    if (spent >= cap) { console.log(`stopped: reported spend $${spent.toFixed(3)} reached the cap of $${cap}`); stopped = true; break; }
    const made = attemptsMade(rows, j.key);
    if (made >= 2) continue;
    /** @type {any} */ let row = null;
    for (let attempt = made; attempt < 2; attempt++) {
      // the run function reads its number from the job so a re-run is a new number that names the one it repeats
      const num = attempt === 0 ? j.n : ++n;
      phase = `run ${num} (${j.name}, rep ${j.rep})`;
      current = { name: j.name, rep: j.rep, n: num }; beat();
      if (stallAt === j.n && attempt === 0) for (;;) { /* blocked on purpose */ }
      // One wall-clock cap for the whole run: a run that hits it is INVALID ("timed out"), its children are ended, and it is re-run once like any invalid run.
      /** @type {any} */ let capTimer = null;
      const capped = new Promise((resolve) => { capTimer = setTimeout(() => resolve("TIMED_OUT"), RUN_CAP_MS); });
      try {
        const got = await Promise.race([j.run(num), capped]);
        if (got === "TIMED_OUT") {
          for (const k of plainKids) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
          await call("agents.stop", { agent: "juno" }).catch(() => null);
          row = endedRow({ name: j.name, rep: j.rep, n: num, why: `timed out: no end after ${Math.round(RUN_CAP_MS / 6000) / 10} minutes`, sha, ms: RUN_CAP_MS });
        } else row = got;
      } catch (e) { console.error(`stopped: ${/** @type {Error} */ (e).message}`); save(); return 1; } finally { clearTimeout(capTimer); }
      row.n = num; row.retryOf = attempt === 0 ? null : (rows.find((/** @type {any} */ r) => keyOf(r) === j.key) || {}).n || j.n;
      rows.push(row); spent += row.usd; save(); console.log(line(row));
      if (row.valid) break;
    }
    current = null;
  }
  const discl = fs.existsSync(path.join(out, "disclosures.json")) ? JSON.parse(fs.readFileSync(path.join(out, "disclosures.json"), "utf8")) : [];
  const md = report(rows, { title: `Honest eval, ${which}`, seal, disclosures: discl });
  fs.writeFileSync(path.join(out, "report.md"), md);
  console.log(`\nreport: ${path.join(out, "report.md")}\nrows: ${rowsFile}\nspent (as Claude Code reported): $${spent.toFixed(3)}${stopped ? " (stopped at the cap)" : ""}`);
  // On the stand-in: every claude child the run started (plain arms, Vyre arm, helper sessions) must have had the subscription token and no rival, read from what each launch logged.
  const launchLog = path.join(out, "launches.jsonl");
  if (standIn && fs.existsSync(launchLog)) {
    const a = authCheck(fs.readFileSync(launchLog, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }));
    console.log(a.problems.length ? `AUTH PROBLEMS:\n  ${a.problems.join("\n  ")}` : `auth: all ${a.launches} claude launches (plain and Vyre arms, helpers) had CLAUDE_CODE_OAUTH_TOKEN and no API key or base URL`);
    if (a.problems.length) return 1;
  }
  const c = ctx.counters(); console.log(`permission asks answered for the person: ${c.allowed} allowed, ${c.refused} refused`);
  return 0;
}
