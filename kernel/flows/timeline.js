// @ts-check
// kernel/flows/timeline: a run read back as a few lines (f12). Pure: it reads the run's ledger (kernel/flows/runner.js writes it: status, attempts, timing, the input of an effect step with secrets hidden, the verify result, who
// answered a card, who gave a substitute value) and the Flow's step labels. One line a step, oldest first; one step in detail on request. The words are plain, the numbers are few, and it costs an agent 100 to 300 tokens.

/** @param {number} ms */
const span = ms => (ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
/** @param {any} v @param {number} n */
const cut = (v, n) => { const t = typeof v === "string" ? v : JSON.stringify(v) ?? ""; return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** The steps of a Flow by id: { label, kind }. @param {any} flow @returns {Map<string, { label: string, kind: string }>} */
export function stepIndex(flow) {
  /** @type {Map<string, { label: string, kind: string }>} */ const m = new Map();
  const walk = (/** @type {any[]} */ steps) => { for (const s of steps || []) { m.set(s.id, { label: s.label || s.id, kind: s.kind }); for (const b of ["then", "else", "steps"]) if (Array.isArray(s[b])) walk(s[b]); if (s.on_fail && Array.isArray(s.on_fail.steps)) walk(s.on_fail.steps); } };
  if (flow) { walk(flow.steps); walk(flow.on_failure); }
  return m;
}

/** What a finished step produced, in a few words. @param {any} e */
function outcomeOf(e) {
  const o = e.output;
  if (o === null || o === undefined) return "";
  if (typeof o === "object") {
    if (o.failed) return `failed, handled: ${cut(o.error && o.error.message, 60)}`;
    if (typeof o.count === "number") return `${o.count} found`;
    if (Array.isArray(o.rows)) return `${o.rows.length} found`;
    if (o.record && o.record.id) return `${o.removed ? "removed" : o.created === false ? "updated" : "record"} ${cut(o.record.id, 24)}`;
    if (o.found === false) return "none found";
    if (o.outcome) return String(o.outcome);
    if (o.branch) return `took ${o.branch}`;
    if (o.dry) return "dry run";
  }
  return "";
}

/**
 * @param {any} run @param {any} [flow] the Flow version the run used, for labels
 * @returns {{ lines: string[], steps: { key: string, id: string }[] }}
 */
export function timelineOf(run, flow) {
  const idx = stepIndex(flow);
  /** @type {string[]} */ const lines = [];
  /** @type {{ key: string, id: string }[]} */ const steps = [];
  let n = 0;
  for (const [key, e] of Object.entries(run.steps || {})) {
    if (!e || key.includes("?retry")) continue;                      // a backoff sleep is part of its step's attempts
    const ask = key.endsWith("?ask");
    const id = key.replace(/\?ask$/, "").replace(/[@!].*$/, "");
    const meta = idx.get(id) || { label: id, kind: "step" };
    const handler = key.includes("!");
    n++;
    steps.push({ key, id });
    const took = typeof e.started_at === "number" && typeof e.finished_at === "number" ? span(e.finished_at - e.started_at) : "";
    const state = ask ? (e.status === "waiting" ? "ASKED" : e.status === "done" ? "approved" : "refused") : e.status === "done" ? "ok" : e.status === "failed_handled" ? "handled" : e.status === "skipped" ? "skipped" : e.status === "failed" ? "FAILED" : e.status === "waiting" ? "WAITING" : "started";
    const bits = [];
    if (ask) { bits.push(e.status === "waiting" ? "waiting for a person's yes" : `${e.output && e.output.outcome ? e.output.outcome : ""}${e.answered && e.answered.by ? ` by ${e.answered.by}` : ""}`.trim()); }
    else {
      const out = outcomeOf(e);
      if (out) bits.push(out);
      if (e.tries) bits.push(`${e.tries + (e.status === "done" || e.status === "failed_handled" ? 1 : 0)} tries${Array.isArray(e.attempts_log) && e.attempts_log.length ? ` (${e.attempts_log.map((/** @type {any} */ a) => a.code).join(", ")}${e.status === "done" ? ", ok" : ""})` : ""}`);
      if (e.verify) bits.push(e.verify.ok ? "verify ok" : `verify FAILED: ${cut(e.verify.say, 60)}`);
      if (e.status === "skipped") bits.push(e.substitute ? `value given by ${e.skipped_by || "a person"}` : "no value needed");
      if (e.status === "failed" && e.error) bits.push(`${e.error.code}: ${cut(e.error.message, 70)}`);
      if (e.status === "waiting" && e.wait) bits.push(e.wait.kind === "time" ? "waiting for a time" : e.wait.kind === "task" ? "waiting for a person" : "waiting");
    }
    lines.push(`#${n} ${handler ? "(failure path) " : ""}${meta.label}${ask ? " (asks first)" : ""}  ${state}${took ? `  ${took}` : ""}${bits.filter(Boolean).length ? `  ${bits.filter(Boolean).join("; ")}` : ""}`);
  }
  const head = `${run.state.toUpperCase()}${run.queued ? ` (held: ${run.queued.reason.replace(/_/g, " ")})` : ""}${run.attention ? `, needs attention: ${run.attention.kind}${run.attention.message ? ` (${cut(run.attention.message, 80)})` : ""}` : ""}`;
  return { lines: [head, ...lines], steps };
}

/**
 * One step in detail: what went in (secrets hidden), what came out, every attempt, the check, who answered.
 * @param {any} run @param {string} which a step id (the first entry with that id) or a ledger key
 */
export function stepDetail(run, which) {
  const entries = Object.entries(run.steps || {});
  const hit = entries.find(([k]) => k === which) || entries.find(([k]) => !k.includes("?") && k.replace(/[@!].*$/, "") === which);
  if (!hit) return null;
  const [key, e] = /** @type {[string, any]} */ (hit);
  const ask = run.steps[`${key}?ask`];
  return { key, status: e.status, ...(e.input !== undefined ? { input: e.input } : {}), ...(e.output !== undefined ? { output: cut(e.output, 1500) } : {}),
    ...(e.error ? { error: e.error } : {}), ...(Array.isArray(e.attempts_log) && e.attempts_log.length ? { attempts: e.attempts_log } : {}), ...(e.tries ? { tries: e.tries } : {}),
    ...(e.verify ? { verify: e.verify } : {}), ...(e.started_at ? { started_at: e.started_at } : {}), ...(e.finished_at ? { finished_at: e.finished_at } : {}),
    ...(e.status === "skipped" ? { skipped_by: e.skipped_by || null, substitute: Boolean(e.substitute) } : {}),
    ...(ask ? { asked: { status: ask.status, ...(ask.output ? { outcome: ask.output.outcome } : {}), ...(ask.answered ? { answered: ask.answered } : {}) } } : {}) };
}
