#!/usr/bin/env node
// @ts-check
// token-proof-world (R031-00n): the seeded box the token proof runs against, built so a paid round only has to press go.
//
//   node scripts/token-proof-world.mjs check --home <dir>     seed the world, then prove each of the ten tasks' tools works for a Vyre agent, with the stand-in claude (no model, no cost)
//   node scripts/token-proof-world.mjs run --home <dir> --max-usd <n> [--arms old,core] [--reps 1] [--only todo,doc] [--out <dir>] [--stand-in]
//                                                             the paid round: the same world, but each task is a fresh thread of the assistant on the REAL claude (behind the tee in
//                                                             scripts/token-proof-claude.mjs), once per arm. Needs VYRE_PROOF_PAID=yes and --max-usd; uses the ANTHROPIC_* auth of the shell.
//                                                             --stand-in runs the same loop on the stand-in claude, to prove the plumbing for nothing.
//
// Starts a DEVELOPMENT vyred in-process on <dir> (kernel on, the presence stand-in), makes the assistant `juno`, seeds what the ten tasks of scripts/lib/token-proof.js need, and probes each task
// the way a session's own MCP server calls (the prompt `vyre-sock <tool> <json>` through the thread's socket, so the call carries the agent's caller and kernel session). Test box only: the host
// guard refuses a person's own Mac.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1"; process.env.VYRE_SESSION_SANDBOX_OFF = "1";
const { start } = await import("../core/daemon/index.js");
const { present, asOwner } = await import("../test/helpers.js");
const { FAKE } = await import("../core/sessions/testing/boot.js");
const { TASKS, ARM_ENV, parseStream, passed, summarize } = await import("./lib/token-proof.js");
const { createSkills, SKILL_MIGRATIONS } = await import("../core/learn/skills.js");
const { DatabaseSync } = await import("node:sqlite");
const { callsOf, runFor, evidenceOf } = await import("../lib/skill-skeleton.js");
const { translate } = await import("../core/switchboard/translate.js");

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("--") ? args[0] : "check";
const flag = (/** @type {string} */ n, /** @type {string} */ d = "") => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
if (!flag("home")) { console.error("--home <dir> is required"); process.exit(2); }
const home = path.resolve(flag("home"));
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 40)); } };

/** @type {{ seed: string, ok: boolean, note: string }[]} */ const report = [];
const seeded = async (/** @type {string} */ name, /** @type {() => Promise<string|void>} */ f) => {
  try { const note = (await f()) || ""; report.push({ seed: name, ok: true, note }); console.log(`seed ok     ${name} ${note}`); }
  catch (e) { const note = String(/** @type {any} */ (e)?.message || e).slice(0, 300); report.push({ seed: name, ok: false, note }); console.log(`seed FAILED ${name}: ${note}`); }
};

// ------------------------------------------------------------------ the fake vendor (Acme): a real HTTP service on this machine, reached through the vault's development-only network seam
const KEY = "fixture-acme-key-0001";
const vendor = http.createServer((req, res) => {
  const ok = req.headers.authorization === `Bearer ${KEY}`;
  const url = new URL(req.url || "/", "http://x");
  const send = (/** @type {number} */ code, /** @type {any} */ body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (!ok) return send(401, { error: "bad key" });
  if (url.pathname === "/v1/status") return send(200, { status: "ok", service: "acme" });
  if (url.pathname === "/v1/customers") return send(200, { data: [{ id: "cus_1", name: "Test Customer" }].slice(0, Number(url.searchParams.get("limit") || 10)), has_more: false });
  return send(404, { error: "not found" });
});
await new Promise((r) => vendor.listen(0, "127.0.0.1", () => r(undefined)));
const vendorPort = /** @type {any} */ (vendor.address()).port;
const { devNet } = await import("../core/vault/request.js");
devNet.deps = {
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  transport: ({ url, method, headers, body }) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: vendorPort, path: url.pathname + url.search, method, headers: { ...headers, host: url.host } }, (res) => {
      /** @type {Buffer[]} */ const parts = []; res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])), body: Buffer.concat(parts) }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  }),
};

// ------------------------------------------------------------------ boot
fs.mkdirSync(home, { recursive: true });
// outside the Vyre home: the files guard never shows a path inside the home
const work = fs.realpathSync(fs.mkdtempSync(`${home}-files-`));
fs.mkdirSync(path.join(work, "northwind"), { recursive: true });
fs.writeFileSync(path.join(work, "northwind", "engagement-letter.txt"), "Engagement letter for Northwind Estate Planning, signed 2 October.\nScope: a trust, two wills and a power of attorney.\n");
const transcripts = path.join(home, "transcripts"); fs.mkdirSync(transcripts, { recursive: true });
// The switchboard reads the claude program once, when the daemon starts: a paid round puts the tee in front of the real claude (or, with --stand-in, in front of the stand-in) from the start.
const TEE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "token-proof-claude.mjs");
if (cmd === "run") { process.env.TOKEN_PROOF_REAL_CLAUDE = args.includes("--stand-in") ? FAKE : flag("claude", "claude"); if (flag("model")) process.env.ANTHROPIC_MODEL = flag("model"); }
Object.assign(process.env, { VYRE_CLAUDE_BIN: cmd === "run" ? TEE_BIN : FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ name: "proof-box", role: "box", transcripts: [transcripts], vault: { keystore: "file" }, recall: { every: 0, vectors: false }, files: { roots: [work] }, projectsDir: path.join(home, "projects"), sessions: { install: false, thread_socket: "on" } }));
const d = await start({ root: home, presence: present, log: () => {}, kernel: true });
asOwner(d, home);
const call = (/** @type {string} */ tool, /** @type {any} */ input = {}, /** @type {string} */ caller = "cli") => d.registry.call(tool, input, caller);
const must = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await call(tool, input); if (r.error) throw new Error(`${tool}: ${r.error.code} ${r.error.message}`); return r.data; };

/** A session's own tool call, the way its MCP server makes it: through the thread's socket, which stamps its caller and kernel session. Returns the JSON the tool answered. */
async function viaSession(/** @type {string} */ agent, /** @type {string} */ tool, /** @type {any} */ input) {
  const r = await call("agents.ask", { agent, text: `vyre-sock ${tool} ${JSON.stringify(input)}`, wait: true, surface: "deck" });
  if (r.error) return { error: r.error };
  const text = typeof r.data.reply === "string" ? r.data.reply : typeof r.data.text === "string" ? r.data.text : JSON.stringify(r.data);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ------------------------------------------------------------------ the world
await seeded("the assistant juno", async () => { await must("agents.create", { name: "juno", kind: "assistant" }); });
await seeded("project northwind (home folder holds the engagement letter)", async () => { const r = await must("projects.create", { name: "northwind", home: path.join(work, "northwind") }); return r.slug || ""; });
await seeded("recall: a memory fact in the project", async () => { await must("memory.write", { kind: "fact", text: "Harlow Legal pays a monthly retainer of $4,200.", project: "northwind" }); });

await seeded("record: client Dana Whitfield, probate", async () => {
  await must("records.define", { diff: { add_types: [{ name: "client", label: "Client", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "case_type", kind: "text", label: "Case type" }] }] } });
  const r = await must("records.create", { type: "client", data: { name: "Dana Whitfield", case_type: "probate" } });
  return JSON.stringify(r).slice(0, 80);
});


await seeded("records: matters for Dana (two Open, one Closed), 214 more clients with one matter each (162 Open and 55 Closed in all)", async () => {
  await must("records.define", { diff: { add_types: [{ name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title", required: true }, { name: "stage", kind: "text", label: "Stage" }, { name: "client_name", kind: "text", label: "Client" }] }] } });
  for (const [title, stage] of [["Estate of Whitfield", "Open"], ["Trust amendment", "Open"], ["Deed transfer", "Closed"]]) await must("records.create", { type: "matter", data: { title, stage, client_name: "Dana Whitfield" } });
  const first = ["Aaron", "Beth", "Carl", "Dina", "Evan", "Fay", "Glen", "Hope", "Ivan", "Jade", "Kurt", "Lena", "Milo", "Nora"];
  const last = ["Abbott", "Acosta", "Adair", "Baird", "Burke", "Cole", "Dunn", "Eaton", "Frost", "Gould", "Hale", "Ibarra", "Joyce", "Keane", "Lowe", "Marsh"];
  let n = 0;
  for (const f of first) for (const l of last) {
    if (n >= 214) break;
    const name = `${f} ${l}`;
    await must("records.create", { type: "client", data: { name, case_type: n % 4 === 0 ? "probate" : "family" } });
    await must("records.create", { type: "matter", data: { title: `${l} file ${n}`, stage: n % 4 === 0 ? "Closed" : "Open", client_name: name } });
    n++;
  }
  return `${n} clients and matters`;
});

/** @type {any} */ let flowId = null;
await seeded("flow: intake-welcome, approved", async () => {
  const flow = { format: 1, name: "intake_welcome", label: "intake-welcome", authorship: "human", trigger: { on: "manual" },
    steps: [{ id: "f", kind: "find", type: "client", where: "record.name == \"Dana Whitfield\"", limit: 1 }] };
  const r = await must("flows.define", { flow });
  if (!r.ok) throw new Error("define: " + JSON.stringify(r).slice(0, 200));
  const host = d.registry.deps.flowsHost.get(d.kernel.id.space);
  await host.flows.tools["flows.approve"](host.personChain(), { id: r.id, version: r.version, hash: r.hash });
  flowId = r.id;
  return String(r.id);
});

await seeded("vault: the stored Acme API key (an api-credential)", async () => {
  await must("vault.put", { name: "acme", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["api.acme-proof.test"], endpoints: [{ method: "GET", path: "/v1/status", kind: "read" }, { method: "GET", path: "/v1/customers", kind: "read" }] }), secret: KEY } });
});
await seeded("connection: Orbit CRM (label, host, key item, check)", async () => {
  await must("vault.put", { name: "orbit-crm-key", kind: "secret", fields: { value: KEY } });
  const r = await must("connectors.connection.create", { label: "Orbit CRM", base_url: "https://api.orbit-proof.test", send: { how: "bearer" }, credential: { item: "orbit-crm-key" }, check: { path: "/v1/status" } });
  return JSON.stringify(r);
});

/** @type {any} */ let projectRecord = null;
/** @type {string | null} */ let teammateAgent = null;
await seeded("teammate: backend on northwind", async () => {
  projectRecord = (await until(async () => { const r = await call("work.project.ref", { project: "northwind" }); return r.error ? null : r.data; }, "the northwind Project record", 20_000)).id;
  const r = await must("team.add", { project: projectRecord, role: "backend", brief: "backend code and errors" });
  teammateAgent = r.agent;
  return `${r.agent} ${r.state}`;
});

/**
 * The person at the Deck. A real Vyre thread asks the person before an agent uses a tool (Claude Code's can_use_tool, raised by the switchboard as an ask), and the person answers allow.
 * In the proof nobody is at the Deck, so this answers for them: allow the Vyre tools the task needs, refuse anything else. Without it the run ends at the first tool call with "Tool permission
 * request failed" and no usage. It answers only asks of the proof's own thread, as the owner, the way the Deck's button does; the model has no way to answer.
 */
const answered = new Set(); let allowed = 0, refused = 0;
const person = setInterval(async () => {
  try {
    const r = await call("threads.asks", {});
    for (const a of Array.isArray(r.data) ? r.data : []) {
      const id = a.id || a.ask; if (!id || answered.has(id)) continue;
      answered.add(id);
      const mine = a.kind === "permission" && /^mcp__[a-z_]*vyre[a-z_]*__/.test(String(a.tool || ""));
      const ans = await call("threads.answer", mine ? { ask: id, decision: "allow" } : { ask: id, decision: "deny", message: "not part of the proof" });
      if (process.env.TOKEN_PROOF_DEBUG) console.log("ask", id, a.tool, a.kind, JSON.stringify(ans).slice(0, 160));
      if (mine) allowed++; else refused++;
    }
  } catch { /* the next tick tries again */ }
}, 150);
person.unref();

/**
 * The skill Vyre would have offered after three clean sessions of the repeat job, through the real path: three scripted runs of the job as thread events (the same translate, receipts and tool-event
 * fields a real thread writes), the evidence found in them, the template draft with the one-call section, proposed and installed as the person would (account scope, under the proof home). The three
 * runs are scripted because a paid model cannot be made to do the same job three times and be marked clean at the next prompt on demand; every step after that is the product's own.
 */
function installRepeatSkill() {
  const STEPS = ["vyre:work.call:clients.find", "vyre:work.call:matters.find", "vyre:planner.add"];
  const run = (/** @type {string} */ who, /** @type {number} */ k) => {
    /** @type {any[]} */ const ev = []; let i = 0;
    const call = (/** @type {string} */ name, /** @type {any} */ input, /** @type {any} */ result) => {
      const id = `tu_${k}_${++i}`;
      ev.push(...translate({ type: "assistant", message: { id: `m${id}`, content: [{ type: "tool_use", id, name, input }] } }).events, ...translate({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(result) }] } }).events);
    };
    call("mcp__vyre__work_call", { tool: "clients.find", input: { where: { name: who } } }, { result: { records: [{ id: `c_${k}` }] } });
    call("mcp__vyre__work_call", { tool: "matters.find", input: { where: { client_name: who } } }, { result: { records: [{ id: `m_${k}` }] } });
    call("mcp__vyre__planner_add", { kind: "todo", title: `Call ${who} about their matters` }, { id: `i_${k}`, kind: "todo" });
    return ev.map((e) => ({ payload: e.payload }));
  };
  const runs = ["Client One", "Client Two", "Client Three"].map((w, k) => runFor(callsOf(run(w, k)), STEPS));
  if (!runs.every(Boolean)) throw new Error("the scripted runs did not match their steps");
  const db = new DatabaseSync(":memory:");
  for (const sql of SKILL_MIGRATIONS) db.exec(sql);
  const skills = createSkills(db, { claudeDir: path.join(home, ".claude-unused") });
  const s = skills.propose({ hash: "proof-repeat", steps: STEPS, sessions: 3, scope: "all", evidence: evidenceOf(/** @type {any} */ (runs)) });
  skills.install(s.id, { home, scope: "account" });
  return s;
}
const removeLearned = () => fs.rmSync(path.join(home, "learned"), { recursive: true, force: true });

/**
 * What this run's own thread wrote: the copy files its claude processes made (`<tee>.<pid>.part`), only those whose session started in the agent's folder under this proof's home, oldest first.
 * Helper sessions (memory, a teammate) start in other folders and are left out, as is anything another proof on the box wrote.
 * @param {string} tee
 */
function readRun(tee) {
  const dir = path.dirname(tee), base = path.basename(tee) + ".";
  const mine = path.join(home, "agents", "juno");
  /** @type {{ at: number, text: string }[]} */ const parts = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.startsWith(base) || !f.endsWith(".part")) continue;
    const file = path.join(dir, f);
    const text = fs.readFileSync(file, "utf8");
    const init = text.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e && e.type === "system" && e.subtype === "init");
    if (init && String(init.cwd || "").startsWith(mine)) parts.push({ at: fs.statSync(file).birthtimeMs || fs.statSync(file).ctimeMs, text });
  }
  return parts.sort((a, b) => a.at - b.at).map((x) => x.text).join("");
}

/** The repeat task passes when exactly one todo has the title, its real id is in the answer, and so is the matter count (one). */
async function verifyRepeat(/** @type {string} */ text) {
  const l = await call("planner.list", { state: "all", limit: 500 });
  const items = (l.data && l.data.items) || (Array.isArray(l.data) ? l.data : []);
  const mine = items.filter((/** @type {any} */ x) => x.title === "Call Aaron Adair about their matters");
  return mine.length === 1 && text.includes(mine[0].id) && /\b(1|one)\b/i.test(text);
}

/** The long task passes when the answer holds the real ids of the two todos it names, and the count. */
async function verifyLong(/** @type {string} */ text) {
  const l = await call("planner.list", { state: "all", limit: 500 });
  const items = (l.data && l.data.items) || (Array.isArray(l.data) ? l.data : []);
  const idOf = (/** @type {string} */ title) => (items.find((/** @type {any} */ x) => x.title === title) || {}).id;
  const a = idOf("Call Aaron Adair"), b = idOf("Call Carl Cole");
  return Boolean(a && b && text.includes(a) && text.includes(b) && /\b(6|six)\b/i.test(text) && items.filter((/** @type {any} */ x) => /^Call /.test(String(x.title))).length === 6);
}

// ------------------------------------------------------------------ the paid round
if (cmd === "run") {
  if (process.env.VYRE_PROOF_PAID !== "yes" && !args.includes("--stand-in")) { console.error("refused: a paid round needs VYRE_PROOF_PAID=yes (the product owner's go)"); await d.stop(); process.exit(2); }
  const cap = Number(flag("max-usd"));
  if (!(cap > 0)) { console.error("refused: --max-usd is required"); await d.stop(); process.exit(2); }
  const ARMS = Object.fromEntries(Object.entries(ARM_ENV).map(([k, v]) => [k, v.env]));
  const arms = flag("arms", "old,core").split(",").filter((a) => a in ARMS), reps = Number(flag("reps", "1")), only = flag("only") ? flag("only").split(",") : null;
  const standIn = args.includes("--stand-in");
  const out = flag("out", fs.mkdtempSync(`${home}-proof-`)); fs.mkdirSync(out, { recursive: true });
  // One proof per out folder: two at once wrote into the same files and made a whole round unreadable.
  const lock = path.join(out, ".world.lock");
  try { const pid = Number(fs.readFileSync(lock, "utf8")); if (pid && pid !== process.pid) { try { process.kill(pid, 0); console.error(`refused: another proof (pid ${pid}) is writing to ${out}`); await d.stop(); process.exit(2); } catch (e) { if (/** @type {any} */ (e).code !== "ESRCH") throw e; } } } catch (e) { if (/** @type {any} */ (e).code !== "ENOENT" && !/another proof/.test(String(/** @type {any} */ (e).message))) { /* an unreadable lock is stale */ } }
  if (fs.existsSync(path.join(out, "rows.json")) && !args.includes("--again")) { console.error(`refused: ${out} already holds a round's rows.json; use a fresh --out, or --again to add to it`); await d.stop(); process.exit(2); }
  fs.writeFileSync(lock, String(process.pid));
  process.on("exit", () => { try { fs.rmSync(lock, { force: true }); } catch { /* gone */ } });
  /** @type {any[]} */ const rows = []; let spent = 0; let rolled = false;
  outer: for (let rep = 0; rep < reps; rep++) for (const task of TASKS.filter((t) => !only || only.includes(t.id))) for (const arm of arms) {
    if (standIn && !task.standIn) continue;
    if (task.arms ? !task.arms.includes(arm) : /^(roll|skill)-/.test(arm) && !only) continue;
    if (spent >= cap) { console.log(`stopped: reported spend $${spent.toFixed(3)} reached the cap of $${cap}`); break outer; }
    // A fresh thread for every run, nothing carried over: stop the agent and delete its threads, or agents.ask would resume the last one (its whole context, the earlier task's included).
    // The teammate the `teammate` task asks keeps working after its task: stop it too, or its session runs on beside the next task.
    if (teammateAgent) { await call("agents.stop", { agent: teammateAgent }); for (const th of ((await call("agents.threads", { agent: teammateAgent })).data || []).map((/** @type {any} */ x) => x.id || x.thread)) if (th) await call("threads.delete", { thread: th }); }
    await call("agents.stop", { agent: "juno" });
    for (const th of ((await call("agents.threads", { agent: "juno" })).data || []).map((/** @type {any} */ x) => x.id || x.thread)) if (th) await call("threads.delete", { thread: th });
    // The window arms: rollover off, or on at 30 percent of the window so it happens in the middle of the long task. Every other arm runs with the defaults (on, 60).
    const rollMode = /** @type {any} */ (ARMS)[arm].VYRE_PROOF_ROLL;
    if (rollMode || rolled) {
      await call("settings.set", { key: "sessions.rollover", value: rollMode !== "off" });
      await call("settings.set", { key: "sessions.rollover_at", value: rollMode === "on" ? 30 : 60 });
      rolled = Boolean(rollMode);
    }
    const skillMode = /** @type {any} */ (ARMS)[arm].VYRE_PROOF_SKILL;
    if (skillMode) { removeLearned(); if (skillMode === "on") installRepeatSkill(); }
    if (task.verify === "long" || task.verify === "repeat") { const l = await call("planner.list", { state: "all", limit: 500 }); for (const it of (l.data && l.data.items) || (Array.isArray(l.data) ? l.data : [])) await call("planner.delete", { id: it.id }); }
    Object.assign(process.env, /** @type {any} */ (ARMS)[arm]);
    if (!process.env.VYRE_MCP_LISTING) delete process.env.VYRE_MCP_LISTING;
    if (!process.env.VYRE_MCP_FEATURES) process.env.VYRE_MCP_FEATURES = "";
    const tee = path.join(out, `${rep}-${task.id}-${arm}.jsonl`);
    process.env.TOKEN_PROOF_TEE = tee;
    const t0 = Date.now();
    const asked = await call("agents.ask", { agent: "juno", text: standIn ? /** @type {string} */ (task.standIn) : task.prompt, wait: true, surface: "deck" });
    // agents.ask answers as soon as the thread stops to ask the person, which can be before the turn is over: wait for the run's own result line (the person's answer comes from the loop above).
    await until(async () => !(await call("threads.asks", {})).data?.length && /"type":"result"/.test(readRun(tee)), `the end of ${task.id} on ${arm}`, 600_000).catch(() => null);
    const stream = readRun(tee);
    const run = parseStream(stream);
    const extra = task.verify === "long" ? await verifyLong(run.text) : task.verify === "repeat" ? await verifyRepeat(run.text) : true;
    const row = { arm, task: task.id, rep, fresh: !/SessionStart:resume/.test(stream), pass: !asked.error && !run.error && passed(task, run) && extra && !/SessionStart:resume/.test(stream) && run.text.trim().length > 0, rolls: asked.data && asked.data.thread ? ((await call("threads.rolls", { thread: asked.data.thread })).data || []).length : null, ranBatch: run.calls.some((c) => /tools_run$/.test(String(c.name))), recoveryCalls: run.calls.filter((c) => /memory_(search|turn)|recall_/.test(String(c.name))).length, armListed: run.mcpToolsListed, askError: asked.error ? asked.error.code : null, ...run, ms: run.ms || Date.now() - t0 };
    spent += run.usd; rows.push(row);
    console.log(`${arm.padEnd(10)} ${task.id.padEnd(10)} ${row.pass ? "PASS" : "FAIL"}  listed ${run.mcpToolsListed}  in ${run.usage.input + run.usage.cacheRead + run.usage.cacheWrite}  out ${run.usage.output}  ${run.turns} turns  ${run.calls.length} calls  $${run.usd.toFixed(4)}  ${(row.ms / 1000).toFixed(1)}s${asked.error ? "  ask: " + asked.error.code : ""}`);
    fs.writeFileSync(path.join(out, "rows.json"), JSON.stringify(rows, null, 1));
  }
  console.log("\n" + JSON.stringify(summarize(rows), null, 1) + `\nrows: ${path.join(out, "rows.json")}\npermission asks answered for the person: ${allowed} allowed, ${refused} refused`);
  vendor.close(); await d.stop(); process.exit(0);
}

// ------------------------------------------------------------------ probes: each task's tool, as the assistant, through its own session
/** [task id, tool, input, what the answer must show] */
const PROBES = [
  ["recall", "memory.retrieve", { question: "Harlow Legal monthly retainer" }, /4,?200/],
  ["todo", "planner.add", { kind: "todo", text: "renew the notary bond by Friday" }, /renew/i],
  ["file", "files.search", { q: "engagement-letter" }, /engagement-letter/],
  ["record", "work.call", { tool: "clients.find", input: { where: { name: "Dana Whitfield" } } }, /probate/],
  ["flow", "flows.start", { id: () => flowId, input: { name: "Test Client" } }, /run_|"run"|started|status/i],
  ["vault", "vault.request", { credential: "acme", method: "GET", url: "https://api.acme-proof.test/v1/status" }, /"status":\s*200|ok/],
  ["connection", "vault.request", { credential: "conn-orbit-crm", method: "GET", url: "https://api.orbit-proof.test/v1/customers", query: { limit: 1 } }, /Test Customer|cus_1/],
  ["chain", "work.call", { tool: "matters.find", input: { where: { client_name: "Dana Whitfield" } } }, /Deed transfer/],
  ["biglist", "work.call", { tool: "clients.find", input: {} }, /Aaron Abbott/],
  ["both", "work.call", { tool: "matters.find", input: {} }, /Deed transfer|Abbott file/],
  ["doc", "docs.find", { query: "pair a phone" }, /\.md/],
  ["skill", "skills.find", { query: "keep a password out of a file" }, /vyre\//],
  ["teammate", "team.ask", { to: "backend", project: () => projectRecord, text: "Please look at the signup error and tell me what you find.", wait: false }, /queued|request|accepted|asleep|"id"/i],
];
if (args.includes("--explore")) {
  const wt = await viaSession("juno", "work.tools", {});
  console.log("work.tools:", JSON.stringify(wt).slice(0, 1500));
}
let proven = 0;
for (const [id, tool, input, want] of PROBES) {
  let text = ""; try { text = JSON.stringify(await viaSession("juno", tool, Object.fromEntries(Object.entries(/** @type {any} */ (input)).map(([k, v]) => [k, typeof v === "function" ? v() : v])))); } catch (e) { text = `error ${/** @type {Error} */ (e).message}`; }
  const ok = !/"error":/.test(text.slice(0, 40)) && want.test(text); proven += ok ? 1 : 0;
  console.log(`probe ${ok ? "ok  " : "FAIL"} ${String(id).padEnd(10)} ${tool}: ${text.slice(0, 150)}  [${text.length} chars, ${Math.ceil(text.length / 4)} tokens, ${(text.match(/"version":/g) || []).length} records]`);
}
console.log(`probes: ${proven} of ${PROBES.length}; the tasks not yet probed: ${TASKS.map((t) => t.id).filter((id) => !PROBES.some((p) => p[0] === id)).join(", ")}`);
await d.stop();
vendor.close();
process.exit(report.every((r) => r.ok) && proven === PROBES.length ? 0 : 1);
