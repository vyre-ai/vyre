// @ts-check
// eval-honest (R031-00v): the pure parts of the honest eval. Nothing here calls a model or reads a key.
//
// What makes it honest, and where each part lives:
//   - pre-registered: scripts/eval-honest/prereg.json holds the tasks, the arms, the reps and the order seed; `sealOf` hashes it together with the held-out file, and the runner refuses to start a paid run
//     if the hash differs from scripts/eval-honest/PREREG.sha256 or the tree is dirty;
//   - verified against the world, no judge: every check below reads a value computed from the seed data (`worldData`) or the world's own state, never a model's opinion;
//   - guards: a run that did not start fresh, ran the wrong number of claude processes, ran another model, or whose roll did not happen is INVALID, listed and re-run once, both reported;
//   - randomized and interleaved: `plan` is a seeded shuffle, one block per rep, every cell in every block;
//   - every run reported: `report` prints each run, failures and invalid runs included, grouped by tree sha.

import crypto from "node:crypto";

// ------------------------------------------------------------------ the world the checks are computed from (the same data scripts/token-proof-world.mjs seeds)
export const KEY = "fixture-acme-key-0001";
export const FIRST = ["Aaron", "Beth", "Carl", "Dina", "Evan", "Fay", "Glen", "Hope", "Ivan", "Jade", "Kurt", "Lena", "Milo", "Nora"];
export const LAST = ["Abbott", "Acosta", "Adair", "Baird", "Burke", "Cole", "Dunn", "Eaton", "Frost", "Gould", "Hale", "Ibarra", "Joyce", "Keane", "Lowe", "Marsh"];

/**
 * The seeded clients and matters, computed rather than read: Dana Whitfield (probate, three matters) and 214 more, one matter each; every fourth is probate and Closed.
 * @returns {{ clients: { name: string, first: string, last: string, case_type: string }[], matters: { title: string, stage: string, client: string }[] }}
 */
export function worldData() {
  /** @type {{ name: string, first: string, last: string, case_type: string }[]} */ const clients = [{ name: "Dana Whitfield", first: "Dana", last: "Whitfield", case_type: "probate" }];
  /** @type {{ title: string, stage: string, client: string }[]} */ const matters = [
    { title: "Estate of Whitfield", stage: "Open", client: "Dana Whitfield" }, { title: "Trust amendment", stage: "Open", client: "Dana Whitfield" }, { title: "Deed transfer", stage: "Closed", client: "Dana Whitfield" },
  ];
  let n = 0;
  for (const f of FIRST) for (const l of LAST) {
    if (n >= 214) break;
    const name = `${f} ${l}`;
    clients.push({ name, first: f, last: l, case_type: n % 4 === 0 ? "probate" : "family" });
    matters.push({ title: `${l} file ${n}`, stage: n % 4 === 0 ? "Closed" : "Open", client: name });
    n++;
  }
  return { clients, matters };
}

/** The client who sorts last by surname, then given name. */
export function lastClient() {
  const { clients } = worldData();
  return [...clients].sort((a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first)).at(-1)?.name || "";
}

// ------------------------------------------------------------------ the pre-registration: hash, order, plan
/** @param {string} text */
export const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** The seal: one hash over the prereg and the held-out file, as written. @param {string} prereg @param {string} heldout */
export const sealOf = (prereg, heldout) => sha256(`${sha256(prereg)}\n${sha256(heldout)}\n`);

/** A small seeded generator (mulberry32). @param {number} seed */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A shuffled copy, the same for the same seed. @template T @param {T[]} xs @param {number} seed @returns {T[]} */
export function shuffle(xs, seed) {
  const r = rng(seed), a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * The runs of an eval in the order they will happen: one block per rep, each block every cell once, the cells of a block shuffled, the blocks shuffled. The same prereg gives the same plan.
 * @param {{ orderSeed: number, reps: number }} p @param {{ id: string, [k: string]: any }[]} cells
 * @returns {{ n: number, rep: number, cell: any }[]}
 */
export function plan(p, cells) {
  /** @type {{ n: number, rep: number, cell: any }[]} */ const out = [];
  const blocks = shuffle(Array.from({ length: p.reps }, (_, i) => i), p.orderSeed);
  for (const rep of blocks) for (const cell of shuffle(cells, p.orderSeed * 1009 + rep + 1)) out.push({ n: out.length + 1, rep, cell });
  return out;
}

/**
 * Lint the scripted conversation: no question may carry an answer (a later question's expected tokens must not appear in any earlier or other user message).
 * @param {{ text: string }[]} messages every user message in order @param {{ index: number, answers: string[] }[]} questions the answer tokens of each question message, by message index
 * @returns {string[]} problems; empty when clean
 */
export function lint(messages, questions) {
  /** @type {string[]} */ const bad = [];
  for (const q of questions) for (const tok of q.answers) {
    const re = new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    messages.forEach((m, i) => { if (i !== q.index && i >= 0 && isQuestion(i, questions) && re.test(m.text)) bad.push(`message ${i + 1} contains "${tok}", an answer to message ${q.index + 1}`); });
    if (re.test(messages[q.index].text)) bad.push(`message ${q.index + 1} contains its own answer "${tok}"`);
  }
  return bad;
}
const isQuestion = (/** @type {number} */ i, /** @type {{ index: number }[]} */ qs) => qs.some((q) => q.index === i);

// ------------------------------------------------------------------ checks: a value computed from the world, compared with the answer
/** @typedef {{ pass: boolean, why: string }} Verdict */
/**
 * @typedef {{ text: string, calls: { name: string, input?: any, ok?: boolean }[], todos?: string[], todoIds?: Record<string, string>, hits?: string[], expect?: Record<string, any> }} Evidence
 *   todos: the titles of every todo the world holds after the run (a plain arm: the lines of todo.txt); todoIds: title to id; hits: the vendor's request log (METHOD /path); expect: values the runner computed from the world before the run
 */

const has = (/** @type {Evidence} */ e, /** @type {string[]} */ names) => e.calls.some((c) => c.ok !== false && names.includes(String(c.name).replace(/^mcp__.*?__/, "").replace(/\./g, "_")));
const hit = (/** @type {Evidence} */ e, /** @type {string} */ path) => (e.hits || []).filter((h) => h.replace(/^\S+\s+/, "").split("?")[0] === path).length;
const NO_KEY = (/** @type {Evidence} */ e) => !e.text.includes(KEY);

/** @type {Record<string, (e: Evidence) => Verdict>} */
export const CHECKS = {
  recall: (e) => ({ pass: /\b4,?200\b/.test(e.text), why: "the retainer, 4,200, in the answer" }),
  todo: (e) => { const n = (e.todos || []).filter((t) => /notary bond/i.test(t)).length; return { pass: n === 1 && /done|added|created|noted|set/i.test(e.text), why: `${n} todo(s) about the notary bond in the world, and the answer says it is done` }; },
  record: (e) => ({ pass: /probate/i.test(e.text), why: "Dana Whitfield's case type, probate" }),
  flow: (e) => ({ pass: has(e, ["flows_start"]) && /complet|succe|finish|done|\bok\b|ran\b/i.test(e.text), why: "flows.start returned without an error and the answer gives a status" }),
  connection: (e) => ({ pass: hit(e, "/v1/customers") >= 1 && /\b(1|one)\b/i.test(e.text), why: "the vendor saw GET /v1/customers and the answer says 1" }),
  vault: (e) => ({ pass: hit(e, "/v1/status") >= 1 && /\b200\b/.test(e.text) && NO_KEY(e), why: "the vendor saw GET /v1/status, the answer says 200 and does not hold the key" }),
  file: (e) => ({ pass: /Engagement letter for Northwind Estate Planning/i.test(e.text), why: "the first line of engagement-letter.txt" }),
  teammate: (e) => ({ pass: has(e, ["team_ask", "agents_ask"]) && /ask/i.test(e.text), why: "team.ask returned without an error and the answer says it asked" }),
  doc: (e) => { const p = String((e.expect || {}).docPath || ""); return { pass: Boolean(p) && e.text.includes(p), why: `the path docs.find gives first for the query (${p || "unknown"})` }; },
  skill: (e) => { const s = String((e.expect || {}).skillId || ""); return { pass: Boolean(s) && e.text.includes(s), why: `the id skills.find gives first for the query (${s || "unknown"})` }; },
  // held-out
  heldout_count: (e) => { const w = worldData(); const n = w.clients.filter((c) => c.case_type === "probate").length; return { pass: new RegExp(`\\b${n}\\b`).test(e.text.replace(/,/g, "")), why: `${n} probate clients` }; },
  heldout_lookup: (e) => { const w = worldData(); const m = w.matters.find((x) => x.title === "Dunn file 70"); return { pass: Boolean(m) && /open/i.test(e.text) && new RegExp(m ? m.client : "", "i").test(e.text), why: `Dunn file 70 is ${m && m.stage} for ${m && m.client}` }; },
  heldout_todo: (e) => { const title = `Call ${lastClient()}`; const n = (e.todos || []).filter((t) => t === title).length; const id = (e.todoIds || {})[title]; return { pass: n === 1 && Boolean(id) && e.text.includes(String(id)), why: `exactly one todo "${title}" and its real id in the answer` }; },
};

/** Words that say plainly it cannot, or asks the person for what it needs: how a plain run without Vyre is told apart from a wrong answer. */
export const DECLINES = /\b(can'?t|cannot|can not|unable|don'?t have|do not have|no access|not able|isn'?t (available|something)|need (access|you to|the)|please (provide|share|paste|give)|which (file|folder)|where (is|are)|could you (share|provide|tell)|not available)\b/i;

/**
 * The outcome of an Eval A run: `pass` (the world check holds), `declined` (a plain arm says it cannot or asks for what it needs, and the check does not hold), `fail` (anything else).
 * A decline is a measure of capability, never counted as a pass. @param {Verdict} v @param {string} text @param {boolean} plain
 */
export const outcomeOf = (v, text, plain) => (v.pass ? "pass" : plain && DECLINES.test(text) ? "declined" : "fail");

// ------------------------------------------------------------------ Eval B's questions
const PHONE = /\(?\b\d{3}\)?[-.\s]*\d{3}[-.\s]*\d{4}\b/;
const NOT_KNOWN = /(don'?t|do not|doesn'?t|no|not|never|nothing).{0,60}(know|have|record|on file|stor|provid|given|mention|said|told|shared)/i;
/** @type {Record<string, (e: Evidence) => Verdict>} */
export const B_CHECKS = {
  q6: (e) => { const id = String((e.expect || {}).secondId || ""); return { pass: Boolean(id) && e.text.includes(id), why: `the id of the second client created (${id || "unknown"})` }; },
  q7: (e) => ({ pass: /retainer-terms-2026/i.test(e.text) && /3,?850/.test(e.text), why: "the file retainer-terms-2026 and the amount 3,850" }),
  q8: (e) => ({ pass: /estate/i.test(e.text) && /father/i.test(e.text), why: "case type Estate, because of her father's will" }),
  q9: (e) => ({ pass: /\bheld\b|awaiting|pending|waiting for (your |the person'?s )?approval/i.test(e.text) && !/successfully sent|was sent|has been sent|went out|was delivered/i.test(e.text) && !PHONE.test(e.text) && NOT_KNOWN.test(e.text), why: "the note was held (not sent), and no phone number was invented: it says it does not know" }),
};

// ------------------------------------------------------------------ guards
/**
 * A run is valid only if the stream shows what the prereg says it should: a fresh thread, the right number of claude processes, the pinned model, and, for a roll arm, a roll that happened.
 * @param {{ fresh: boolean, processes: number, model: string, models?: string[], rolled?: boolean|null, compacted?: boolean|null }} run
 * @param {{ model: string, processes: number|number[], roll?: "vyre"|"compact"|"none"|null }} want
 * @returns {string[]} reasons the run is invalid; empty when valid
 */
export function guards(run, want) {
  /** @type {string[]} */ const bad = [];
  if (!run.fresh) bad.push("the first message resumed an earlier session (SessionStart:resume)");
  const ok = Array.isArray(want.processes) ? want.processes : [want.processes];
  if (!ok.includes(run.processes)) bad.push(`${run.processes} claude process(es), expected ${ok.join(" or ")}`);
  if (want.model && run.model && run.model !== want.model) bad.push(`ran ${run.model}, pinned ${want.model}`);
  if (run.models && run.models.length > 1) bad.push(`the model changed during the run: ${run.models.join(", ")}`);
  if (want.model && !run.model) bad.push("the stream did not name its model");
  if (want.roll === "vyre" && !run.rolled) bad.push("the roll did not happen (no thread.rolled and a second process with the seed)");
  if (want.roll === "compact" && !run.compacted) bad.push("no compaction summary in the stream");
  return bad;
}

/** Did the stream show Claude Code's own compaction? @param {string} stream */
export const compactedIn = (stream) => /"subtype":"compact_boundary"|"compact_metadata"|This session is being continued from a previous conversation/.test(stream);

/**
 * The model the stream's init events named, and how many init events it holds. Claude Code in stream-json mode emits one init per message, so an init count is NOT a process count (probe 1: one process, ten
 * inits); the number of claude processes is the number of tee files (`parts`) the run made. `models` lists every distinct model seen, so a run that changed model midway is caught.
 * @param {string} stream
 */
export function initsOf(stream) {
  /** @type {string[]} */ const models = [];
  for (const line of stream.split("\n")) { try { const e = JSON.parse(line); if (e.type === "system" && e.subtype === "init") models.push(String(e.model || "")); } catch { /* not a json line */ } }
  return { inits: models.length, model: models[0] || "", models: [...new Set(models)] };
}

// ------------------------------------------------------------------ authentication
/** The variables that would send a run somewhere other than the subscription. */
export const RIVAL_AUTH = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

/**
 * Why a paid run may not start: it authenticates from CLAUDE_CODE_OAUTH_TOKEN (the owner's subscription) alone.
 * @param {Record<string, string | undefined>} env @returns {string[]}
 */
export function authProblems(env) {
  /** @type {string[]} */ const bad = [];
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) bad.push("CLAUDE_CODE_OAUTH_TOKEN is not set");
  for (const k of RIVAL_AUTH) if (env[k]) bad.push(`${k} is set (a run must authenticate from the subscription token alone)`);
  return bad;
}

/**
 * What the launches the stand-in saw say about authentication: every child must have had the token and none a rival.
 * @param {{ oauth?: boolean, rival?: string[], argv?: string[], env_model?: string | null }[]} launches
 * @returns {{ launches: number, problems: string[] }}
 */
export function authCheck(launches) {
  const l = launches.filter((x) => x && Array.isArray(x.argv));
  /** @type {string[]} */ const problems = [];
  if (!l.length) problems.push("no launch was seen, so nothing was checked");
  l.forEach((x, i) => {
    if (!x.oauth) problems.push(`launch ${i + 1} had no CLAUDE_CODE_OAUTH_TOKEN`);
    if (x.rival && x.rival.length) problems.push(`launch ${i + 1} had ${x.rival.join(", ")}`);
  });
  return { launches: l.length, problems };
}

// ------------------------------------------------------------------ ended runs and resuming
/** The key a run is known by across a resume: the eval, the task, the cell and the rep. @param {{ eval: string, task: string, cell: string, rep: number }} r */
export const keyOf = (r) => `${r.eval}|${r.task}|${r.cell}|${r.rep}`;

/**
 * The row of a run that was ended before it finished (it hit its time cap, or the harness stalled): invalid and listed, and re-run once like any invalid run.
 * @param {{ name: string, rep: number, n: number, why: string, sha: string, ms?: number }} j `name` is "A <task>/<arm>" or "B <arm>"
 * @returns {Row}
 */
export function endedRow(j) {
  const [ev, ...rest] = j.name.split(" "), id = rest.join(" ");
  const [task, arm] = ev === "B" ? ["memory", id] : [id.split("/")[0] || "", id.split("/").pop() || ""];
  return { eval: ev, cell: arm, task, group: "", rep: j.rep, n: j.n, valid: false, invalid: [j.why], outcome: "fail", why: j.why.split(":")[0], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usd: 0, ms: j.ms || 0, turns: 0, calls: 0, sha: j.sha, stream: "" };
}

/**
 * How many attempts of one run the rows already hold, so a resumed eval starts where it stopped: 0 or 1 attempts made (the next is attempt 0 or the single re-run), and 2 when the run is done (a valid row,
 * or the original and its re-run). @param {{ eval: string, task: string, cell: string, rep: number, valid: boolean }[]} rows @param {string} key
 */
export function attemptsMade(rows, key) {
  const had = rows.filter((r) => keyOf(r) === key);
  return had.some((r) => r.valid) ? 2 : Math.min(had.length, 2);
}

// ------------------------------------------------------------------ the report
/**
 * @typedef {{ eval: string, cell: string, task: string, group?: string, rep: number, n: number, valid: boolean, invalid?: string[], outcome: string, why?: string, retryOf?: number|null,
 *   usage: { input: number, output: number, cacheRead: number, cacheWrite: number }, usd: number, ms: number, turns: number, calls: number, sha: string, stream?: string }} Row
 */
const f$ = (/** @type {number} */ n) => `$${n.toFixed(3)}`;
const sum = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0);

/**
 * The report: a table per cell (pass, declined, fail and invalid counted apart; the per-rep values listed, not a mean alone), then every run. Nothing is dropped.
 * @param {Row[]} rows @param {{ title?: string, seal?: string, disclosures?: string[] }} [o]
 */
export function report(rows, o = {}) {
  const lines = [`# ${o.title || "Honest eval report"}`, ""];
  if (o.seal) lines.push(`Pre-registration seal: ${o.seal}`, "");
  for (const d of o.disclosures || []) lines.push(`Disclosure: ${d}`, "");
  lines.push("Disclosure: every dollar figure is an estimate: Claude Code's own count of tokens at list price. The runs were paid from the owner's subscription, not per token.", "");
  lines.push("Disclosure: the process-count guard was corrected after probe 1, before any counted run. It first counted init events (Claude Code emits one per message, so a ten-message thread showed ten); it now counts claude processes (the tee files a run made) and also requires one model throughout. Guards are not part of the pre-registration.", "");
  const shas = [...new Set(rows.map((r) => r.sha))];
  lines.push(`Tree sha(s) the runs were made on: ${shas.join(", ") || "none"}${shas.length > 1 ? " (more than one: a fix was made between runs; the cells below are split by it in the run list)" : ""}.`, `Runs: ${rows.length} (${rows.filter((r) => r.valid).length} valid, ${rows.filter((r) => !r.valid).length} invalid, listed). Spend: ${f$(sum(rows.map((r) => r.usd)))}.`, "");
  for (const ev of [...new Set(rows.map((r) => r.eval))]) {
    const er = rows.filter((r) => r.eval === ev);
    lines.push(`## ${ev}`, "", "| cell | group | valid runs | pass | declined | fail | invalid | tokens in (fresh / cache read / cache write) | out | cost | seconds | turns |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    const keys = [...new Set(er.map((r) => `${r.cell}\u0000${r.group || ""}`))];
    for (const k of keys) {
      const [cell, group] = k.split("\u0000");
      const rs = er.filter((r) => r.cell === cell && (r.group || "") === group), v = rs.filter((r) => r.valid);
      const m = (/** @type {(r: Row) => number} */ g) => (v.length ? sum(v.map(g)) / v.length : 0);
      lines.push(`| ${cell} | ${group || "-"} | ${v.length} | ${v.filter((r) => r.outcome === "pass").length} | ${v.filter((r) => r.outcome === "declined").length} | ${v.filter((r) => r.outcome === "fail").length} | ${rs.length - v.length} | ${Math.round(m((r) => r.usage.input))} / ${Math.round(m((r) => r.usage.cacheRead))} / ${Math.round(m((r) => r.usage.cacheWrite))} | ${Math.round(m((r) => r.usage.output))} | ${f$(m((r) => r.usd))} | ${Math.round(m((r) => r.ms) / 100) / 10} | ${Math.round(m((r) => r.turns) * 10) / 10} |`);
    }
    lines.push("", "Per task and cell, each rep (P pass, D declined, F fail, x invalid):", "");
    const byTask = [...new Set(er.map((r) => r.task))];
    for (const t of byTask) {
      const cells = [...new Set(er.filter((r) => r.task === t).map((r) => r.cell))];
      lines.push(`- ${t}: ${cells.map((c) => `${c} ${er.filter((r) => r.task === t && r.cell === c).sort((a, b) => a.n - b.n).map((r) => (r.valid ? ({ pass: "P", declined: "D", fail: "F" }[r.outcome] || "?") : "x")).join("")}`).join("; ")}`);
    }
    lines.push("", "Every run, in the order it was made:", "", "| # | cell | task | rep | valid | outcome | why or reason | cost | stream |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of [...er].sort((a, b) => a.n - b.n)) lines.push(`| ${r.n} | ${r.cell} | ${r.task} | ${r.rep} | ${r.valid ? "yes" : "NO"} | ${r.valid ? r.outcome : "invalid"} | ${(r.valid ? r.why : (r.invalid || []).join("; ")) || ""}${r.retryOf ? ` (re-run of #${r.retryOf})` : ""} | ${f$(r.usd)} | ${r.stream || ""} |`);
    lines.push("");
  }
  return lines.join("\n");
}
