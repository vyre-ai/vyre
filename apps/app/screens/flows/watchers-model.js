// @ts-check
// Watchers as people read them (watchers.list, watchers.preset, watchers.test, watchers.card): the state in words, the next and last run, which buttons a row has, and the few fields a preset asks for.
// Pure; the tools are called in watchers-source.ts. A watcher is a small folder of code the box runs on a schedule; a preset writes one for a common source, left off until its card is turned on.

/** @typedef {{ name: string, state: string, title?: string | null, project?: string | null, schedule?: string | null, every?: string | null, next?: string | null, lastRun?: string | null, lastError?: string | null, failures?: number, pausedWhy?: string | null, items?: number, problems?: string[] }} WatcherRow */

const STATE = /** @type {Record<string, { word: string, tone: "ok" | "warn" | "err" | "plain" }>} */ ({
  draft: { word: "Draft, not on yet", tone: "plain" }, on: { word: "On", tone: "ok" }, paused: { word: "Paused", tone: "warn" },
  changed: { word: "Changed since it was turned on", tone: "warn" }, invalid: { word: "Cannot run", tone: "err" }, missing: { word: "Its folder is gone", tone: "err" },
});

/** "2026-10-19T05:00:00.000Z" as "19 Oct, 05:00" in the viewer's own zone; "" when there is none. @param {string | null | undefined} iso @param {(ms: number) => string} [fmt] */
export const when = (iso, fmt) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? (fmt ? fmt(t) : new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })) : ""; };

/** One watcher as a row. A watcher that has failed says so even while it is "on". @param {WatcherRow} w @param {(ms: number) => string} [fmt] */
export function watcherRow(w, fmt) {
  const s = STATE[w.state] ?? { word: w.state, tone: /** @type {const} */ ("plain") };
  const failing = w.state === "on" && (w.failures ?? 0) > 0;
  const bits = [w.every ? `Runs ${w.every}` : "", w.state === "on" && w.next ? `next ${when(w.next, fmt)}` : "", w.lastRun ? `last ${when(w.lastRun, fmt)}` : "", w.items ? `${w.items} filed` : ""].filter(Boolean);
  return {
    name: w.name, title: w.title || w.name, state: failing ? "failing" : w.state, word: failing ? `Failing (${w.failures} in a row)` : s.word, tone: failing ? /** @type {const} */ ("err") : s.tone,
    sub: bits.join(" · "), problem: failing ? w.lastError || "" : w.state === "paused" ? w.pausedWhy || "" : (w.problems ?? [])[0] ?? "",
    actions: /** @type {("run" | "pause" | "resume" | "turn-on" | "delete")[]} */ (
      w.state === "on" ? ["run", "pause", "delete"] : w.state === "paused" ? ["resume", "delete"] : w.state === "draft" || w.state === "changed" ? ["turn-on", "delete"] : ["delete"]),
  };
}

/** The sources a watcher can be made for, and the few things each asks. `credential` is the name of a Vault item, never a value. @type {{ kind: string, label: string, hint: string, fields: { key: string, label: string, help?: string, optional?: boolean, choices?: [string, string][] }[] }[]} */
export const PRESETS = [
  { kind: "mail", label: "Mail", hint: "Notes for important mail that arrives", fields: [{ key: "credential", label: "Google credential, in the Vault", help: "The name of the Vault item that holds your Google sign-in." }, { key: "instruction", label: "What counts as important", optional: true }] },
  { kind: "calendar", label: "Calendar", hint: "A note for each new or changed matching event", fields: [{ key: "credential", label: "Google credential, in the Vault" }, { key: "match", label: "Words to look for", help: "Separated by commas.", optional: true }, { key: "days", label: "Days ahead to look", optional: true }] },
  { kind: "repo", label: "Repo", hint: "New issues or pull requests that match", fields: [{ key: "repo", label: "Repository", help: "owner/name" }, { key: "only", label: "Watch", optional: true, choices: [["both", "Issues and pull requests"], ["issues", "Issues"], ["pulls", "Pull requests"]] }, { key: "credential", label: "GitHub credential, in the Vault", optional: true }, { key: "match", label: "Words to look for", optional: true }] },
  { kind: "slack", label: "Slack", hint: "New messages in a channel", fields: [{ key: "channel", label: "Channel id" }, { key: "credential", label: "Slack credential, in the Vault" }, { key: "match", label: "Words to look for", optional: true }] },
  { kind: "feed", label: "Feed", hint: "New items in an RSS or Atom feed", fields: [{ key: "url", label: "Feed address", help: "https://example.com/feed.xml" }, { key: "match", label: "Words to look for", optional: true }] },
  { kind: "pr", label: "Pull requests", hint: "Others' new comments on a session's pull requests", fields: [{ key: "session", label: "Session id" }] },
  { kind: "connector", label: "Connector", hint: "Polls a connection you made, read only", fields: [{ key: "connection", label: "Connection id" }, { key: "poll", label: "Which poll" }] },
];

/** The words typed as a list: "a, b" is ["a", "b"]. @param {string} t */
const words = (t) => String(t || "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The watchers.preset input for what was typed, or the first thing still missing in words.
 * @param {string} kind @param {string} project @param {Record<string, string>} v @returns {{ input: Record<string, unknown> } | { missing: string }}
 */
export function presetInput(kind, project, v) {
  const p = PRESETS.find((x) => x.kind === kind);
  if (!p) return { missing: "Choose where it watches." };
  if (!String(project || "").trim()) return { missing: "Choose the project it belongs to." };
  /** @type {Record<string, unknown>} */ const input = { kind, project: project.trim() };
  for (const f of p.fields) {
    const val = String(v[f.key] ?? "").trim();
    if (!val) { if (f.optional) continue; return { missing: `${f.label}: fill this in.` }; }
    input[f.key] = f.key === "match" ? words(val) : f.key === "days" ? Number(val) : val;
  }
  if (input.days !== undefined && !(Number.isInteger(input.days) && /** @type {number} */ (input.days) > 0)) return { missing: "Days ahead: a whole number." };
  return { input };
}

/** What a dry run found, as lines: how many items it would file and what they are, or what to fix. @param {any} r */
export function testLines(r) {
  if (!r || r.ok === false) {
    const lines = [r?.error ? String(r.error) : "", ...(Array.isArray(r?.problems) ? r.problems.map(String) : [])].filter(Boolean).slice(0, 6);
    return { ok: false, lines: lines.length ? lines : ["The test did not run."] };
  }
  const items = Array.isArray(r.items) ? r.items : [];
  const first = items.slice(0, 5).map((/** @type {any} */ i) => String(i.title || i.subject || i.summary || i.id || "An item").slice(0, 120));
  return { ok: true, lines: [r.count ? `It would file ${r.count} ${r.count === 1 ? "item" : "items"}${r.alreadyFiled ? `, ${r.alreadyFiled} already filed` : ""}.` : "It found nothing new. That can be right.", ...first, ...(r.warning ? [String(r.warning)] : [])] };
}

/** The card shown before Turn on: when, what it checks, what it does, what it reads, whether it acts and what it costs. @param {any} c */
export function cardRows(c) {
  if (!c) return [];
  const l = c.lines ?? {}, f = c.facts ?? {};
  return [["When", l.when], ["Checks", l.check], ["Does", l.do], ["Reads", f.readsText], ["Acts", f.acts], ["Costs", f.cost]].filter(([, v]) => v).map(([k, v]) => ({ label: String(k), text: String(v) }));
}
