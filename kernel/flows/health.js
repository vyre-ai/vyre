// @ts-check
// kernel/flows/health: the one line that says how a Flow is (f8). Pure over what the runner already holds: the Flow's recent runs, the Space's switch, when it runs next and the lights of the Connections it
// uses. Used by flows.list (a row each, a few tokens), flows.health, the Deck, the phone, the CLI and the assistant's glance, so every surface says the same thing.

/** @param {number} ms */
function ago(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}
/** @param {number} at @param {number} now @param {string} tz */
function when(at, now, tz) {
  try {
    const fmt = (/** @type {any} */ o) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...o }).format(new Date(at));
    const sameDay = fmt({ year: "numeric", month: "numeric", day: "numeric" }) === new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).format(new Date(now));
    return sameDay ? `today ${fmt({ hour: "2-digit", minute: "2-digit", hour12: false })}` : at - now < 6 * 86_400_000 ? `${fmt({ weekday: "long" })} ${fmt({ hour: "2-digit", minute: "2-digit", hour12: false })}` : fmt({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return new Date(at).toISOString(); }
}

/** The connectors a Flow's service steps use. @param {any} flow @returns {string[]} */
export function connectorsOf(flow) {
  /** @type {Set<string>} */ const out = new Set();
  const walk = (/** @type {any[]} */ steps) => { for (const s of steps || []) { if (s.kind === "service" && typeof s.connector === "string") out.add(s.connector); for (const b of ["then", "else", "steps"]) if (Array.isArray(s[b])) walk(s[b]); if (s.on_fail && Array.isArray(s.on_fail.steps)) walk(s.on_fail.steps); } };
  if (flow) { walk(flow.steps); walk(flow.on_failure); }
  return [...out];
}

/**
 * @param {{ id: string, label: string, status: string, paused?: { reason?: string, since?: number } | null, runs: any[], now: number, nextAt?: number | null, tz?: string,
 *   lights?: Record<string, string>, connectors?: string[], control?: { mode: string, reason?: string }, held?: number, testFailing?: string }} i
 * @returns {{ id: string, label: string, level: 'green'|'amber'|'red'|'grey', line: string, last: { run: string, state: string, at: number } | null, week: { ok: number, failed: number, total: number }, next: number | null, attention: number, held: number, red_connections: string[] }}
 */
export function healthOf(i) {
  // a lane of a parallel step is part of its parent's run: it counts for what needs a person, not as a run of its own
  const own = i.runs.filter(r => !(r.parent && r.parent.lane));
  const week = own.filter(r => i.now - r.started_at < 7 * 86_400_000);
  const ended = week.filter(r => ["done", "failed", "cancelled"].includes(r.state));
  const ok = ended.filter(r => r.state === "done").length, failed = ended.filter(r => r.state === "failed").length;
  const last = [...own].sort((a, b) => b.started_at - a.started_at)[0] || null;
  // a lane or sub-flow whose parent already reports the failure is one thing to look at, the parent's (the same rule as the Needs-you list)
  const byId = new Map(i.runs.map(r => [r.id, r]));
  const reported = (/** @type {any} */ r) => { const p = r.parent && byId.get(r.parent.run); return Boolean(p && p.state === "failed" && p.error && /^(branch|subflow)_failed$/.test(p.error.code)); };
  const attention = i.runs.filter(r => (r.attention && !["done", "cancelled"].includes(r.state) || (r.attention && r.attention.kind === "verify")) && !reported(r)).length;
  const held = i.held ?? i.runs.filter(r => r.state === "queued").length;
  const lights = i.lights || {};
  const redConns = (i.connectors || []).filter(c => lights[c] === "red" || lights[c.replace(/^conn-/, "")] === "red");
  const pieces = [];
  let level = /** @type {'green'|'amber'|'red'|'grey'} */ ("green");
  const raise = (/** @type {'amber'|'red'|'grey'} */ l) => { const rank = { green: 0, grey: 0, amber: 1, red: 2 }; if (rank[l] > rank[level]) level = l; };
  if (i.control && i.control.mode !== "running") { pieces.push(`Everything is ${i.control.mode === "draining" ? "draining" : "paused"}${i.control.reason ? ` (${i.control.reason})` : ""}${held ? `; ${held} held` : ""}`); raise("amber"); }
  else if (i.status === "paused") { pieces.push(`Paused${i.paused && i.paused.reason ? `: ${i.paused.reason}` : ""}${held ? `; ${held} held` : ""}`); raise("amber"); }
  else if (i.status !== "active") { pieces.push(i.status === "disabled" ? "Switched off" : "Not approved yet"); raise("grey"); }
  if (redConns.length) { pieces.unshift(`Red: ${redConns.map(c => c.replace(/^conn-/, "")).join(", ")} ${redConns.length === 1 ? "is" : "are"} down${held || attention ? "" : ""}`); raise("red"); }
  if (i.testFailing) { pieces.unshift(`Red: a saved test fails (${i.testFailing})`); raise("red"); }
  if (last) pieces.push(`Last run ${ago(i.now - last.started_at)}${last.state === "failed" ? ", failed" : last.state === "waiting" ? ", waiting" : last.state === "queued" ? ", held" : ""}`);
  else pieces.push("Never run");
  if (ended.length) { pieces.push(`${ok} of ${ended.length} ok this week`); if (failed) raise(failed * 2 >= ended.length ? "red" : "amber"); }
  if (attention) { pieces.push(`${attention} need${attention === 1 ? "s" : ""} you`); raise("amber"); }
  if (i.status === "active" && !(i.control && i.control.mode !== "running") && i.nextAt) pieces.push(`next ${when(i.nextAt, i.now, i.tz || "UTC")}`);
  return { id: i.id, label: i.label, level, line: pieces.join(". ").replace(/\.\./g, "."), last: last ? { run: last.id, state: last.state, at: last.started_at } : null, week: { ok, failed, total: ended.length },
    next: i.nextAt ?? null, attention, held, red_connections: redConns };
}
