// @ts-check
// What a chat shows beside its transcript, read from the shapes the box really emits (not guessed):
//  - threads.queue (core/switchboard/index.js): { queued: [{ queued: <row id>, uuid, text, surface, at, request }] }, the rows "Send now" takes by `queued`.
//  - the spend.capped event (core/spend/index.js): { provider, day, spent, cap, line, thread?, agent?, action: { label, tool, input } }; the one for THIS chat has payload.thread equal to the chat.
//  - watchers.shown (core/watchers/index.js): { project, kinds, watchers: [{ name, hash, title, state, project, at }] }, the watcher cards the assistant has shown in a thread.

/** The queued words of a threads.queue answer, as the tools sheet takes them. @param {any} data @returns {{ queued: number, text: string }[]} */
export function queueFrom(data) {
  const rows = data && Array.isArray(data.queued) ? data.queued : [];
  return rows.filter((/** @type {any} */ r) => r && Number.isInteger(r.queued)).map((/** @type {any} */ r) => ({ queued: r.queued, text: String(r.text ?? "") }));
}

/** Is this box event the spend cap that paused THIS chat? @param {{ type?: string, payload?: any } | null | undefined} e @param {string} thread */
export const isSpendCapFor = (e, thread) => Boolean(e) && e?.type === "spend.capped" && Boolean(e?.payload) && String(e?.payload?.thread ?? "") === thread;

/** The card's data from that event's payload (the card checks the provider itself). @param {any} p */
export const spendCardData = (p) => ({ provider: p.provider, cap: p.cap, line: p.line, action: p.action });

/** The names of the watcher cards shown in this thread, oldest first, each once. @param {any} data */
export function watcherNames(data) {
  const rows = data && Array.isArray(data.watchers) ? data.watchers : [];
  const seen = new Set();
  /** @type {string[]} */ const out = [];
  for (const w of rows) { const n = w && typeof w.name === "string" ? w.name : ""; if (n && !seen.has(n)) { seen.add(n); out.push(n); } }
  return out;
}

/** Did the assistant call a tool that shows a watcher card? The row's tool is watchers.card or watchers.preset, possibly with an MCP prefix and underscores. @param {string} tool */
export const showsWatcherCard = (tool) => /(^|[._]|__)watchers[._](card|preset)$/.test(String(tool));

/**
 * An artifact the assistant made in this chat. The stream's frame is a finished tool row keyed `art:<artifact id>:<version>` whose words are "Artifact <title>" (core/stream/adapter.js, thread.artifact):
 * the row key is "t:" and that id. @param {string} key @param {unknown} text @returns {{ id: string, version: number, title: string } | null}
 */
export function artifactOf(key, text) {
  const m = /^t:art:(.+):(\d+)$/.exec(String(key));
  if (!m) return null;
  const words = typeof text === "string" ? text.replace(/^Artifact\s+/, "").trim() : "";
  return { id: m[1], version: Number(m[2]), title: words || "Artifact" };
}

/** Where a chat's artifact opens: the artifact page, at the version the chat made. @param {{ id: string, version: number }} a */
export const artifactHref = (a) => `/a/${encodeURIComponent(a.id)}${a.version > 0 ? `?v=${a.version}` : ""}`;
