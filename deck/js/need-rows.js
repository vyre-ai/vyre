// @ts-check
// The words and numbers of a Needs you row on the phone (docs/design/phone.md sections 4, 5, 12),
// kept free of the DOM so node:test can check them: the title by kind, the three lines, the
// time, the accessibility label, the Face ID word for this device, where Open session goes, and
// what a released swipe does. deck/js/now-phone.js and deck/js/need-sheet.js draw with these.

/** @typedef {{ kind: string, at: number, agent?: string|null, projectName?: string|null, threadName?: string|null, title?: string,
 *   command?: string, tool?: string, detail?: any, questions?: any[], why?: string, thread?: string|null, anchor?: any,
 *   gate?: { kind?: string, via?: string, to?: string[], toName?: string, summary?: string, draft?: Record<string, any>|null } | null,
 *   pair?: { name: string, node?: string|null, login?: string, expires: number } }} Item */

const lastPart = (/** @type {string} */ p) => String(p || "").split("/").filter(Boolean).pop() || String(p || "");

/**
 * An ask as the action it asks for: "Push q3-report", "Edit q3.tsx", "Run npm". Built only from
 * what the command or tool names; anything it cannot read becomes "Run <program>" or "Use <tool>".
 * @param {string} tool @param {any} [detail] @param {string} [summary]
 */
export function askTitle(tool, detail, summary) {
  const d = detail || {};
  if (tool === "Bash" || (!tool && summary)) {
    const cmd = String(d.command || summary || "").trim();
    const w = cmd.replace(/^(sudo|env\s+\S+=\S+)\s+/, "").split(/\s+/).filter(Boolean);
    const prog = lastPart(w[0] || "");
    if (prog === "git") {
      const sub = w[1] || "";
      const args = w.slice(2).filter(x => !x.startsWith("-"));
      if (sub === "push") return args[1] ? `Push ${args[1].replace(/^\+/, "").split(":").pop()}` : "Push";
      if (sub === "commit") return "Commit";
      if (sub === "reset") return "Reset the branch";
      if (sub === "checkout" || sub === "switch") return args[0] ? `Switch to ${args[0]}` : "Switch branch";
      if (sub === "merge") return args[0] ? `Merge ${args[0]}` : "Merge";
      if (sub === "rebase") return "Rebase";
      if (sub) return `Run git ${sub}`;
    }
    if (prog === "rm") { const t = w.slice(1).filter(x => !x.startsWith("-")); return t.length ? `Delete ${lastPart(t[0])}` : "Delete files"; }
    if ((prog === "npm" || prog === "pnpm" || prog === "yarn") && w[1]) {
      if (w[1] === "run" && w[2]) return `Run ${w[2]}`;
      if (w[1] === "test" || w[1] === "t") return "Run the tests";
      if (w[1] === "install" || w[1] === "i" || w[1] === "add") return w[2] && !w[2].startsWith("-") ? `Install ${w[2]}` : "Install packages";
      if (w[1] === "publish") return "Publish the package";
    }
    if (prog === "curl" || prog === "wget") { const u = w.find(x => /^https?:\/\//.test(x)); const host = u ? hostOf(u) : ""; return host ? `Fetch ${host}` : "Fetch a URL"; }
    return prog ? `Run ${prog}` : "Run a command";
  }
  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return d.file ? `Edit ${lastPart(d.file)}` : "Edit a file";
  if (tool === "Write") return d.file ? `Write ${lastPart(d.file)}` : "Write a file";
  if (tool === "Read") return d.file ? `Read ${lastPart(d.file)}` : "Read a file";
  if (tool === "WebFetch") return d.url ? `Fetch ${hostOf(d.url) || d.url}` : "Fetch a page";
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool || "");
  if (m) return `Use ${m[2].replace(/[_-]+/g, " ")}`;
  return tool ? `Use ${tool}` : "Run a command";
}

function hostOf(/** @type {string} */ u) { try { return new URL(u).host; } catch { return ""; } }

/**
 * A held item's title, verb and person: "Send email to Dana", "Spend through stripe".
 * @param {{ kind?: string, via?: string, to?: string[], toName?: string } | null | undefined} g
 */
export function draftTitle(g) {
  if (!g) return "Send a message";
  if (g.kind === "spend") return `Spend through ${g.via || "a connector"}`;
  if (g.kind === "delete") return `Delete through ${g.via || "a connector"}`;
  const name = g.toName ? String(g.toName).trim().split(/\s+/)[0] : (g.to || [])[0] || "";
  const what = /mail/i.test(g.via || "") || (!g.via && /@/.test(name)) ? "email" : "message";
  return name ? `Send ${what} to ${name}` : `Send ${what}`;
}

/** @param {Item} n */
export function titleOf(n) {
  if (n.kind === "draft") return draftTitle(n.gate);
  if (n.kind === "question") return `${n.agent || "A session"} has a question`;
  if (n.kind === "pair") return `Pair ${n.pair?.name || "a Mac"}`;
  return askTitle(n.tool || "", n.detail, n.command);
}

/**
 * Line 2: the command for an ask (mono), the subject for a draft, the question for a question.
 * @param {Item} n @returns {{ text: string, mono: boolean }}
 */
export function secondLine(n) {
  if (n.kind === "ask") return { text: String(n.detail?.command || n.detail?.file || n.detail?.url || n.command || ""), mono: true };
  if (n.kind === "draft") {
    const s = n.gate?.draft?.subject;
    return { text: typeof s === "string" && s ? s : String(n.gate?.summary || ""), mono: false };
  }
  if (n.kind === "question") return { text: String(n.questions?.[0]?.question || n.why || ""), mono: false };
  if (n.kind === "pair") return { text: "Type the code shown on it", mono: false };
  return { text: "", mono: false };
}

/** Line 3: "<agent> · <project>". @param {Item} n */
export function thirdLine(n) {
  if (n.kind === "pair") return [n.pair?.node, n.pair?.login].filter(Boolean).join(" · ") || "A Mac asking to pair";
  return [n.agent || (n.kind === "draft" ? "an agent" : "a session"), n.projectName || n.threadName].filter(Boolean).join(" · ");
}

/** "now", "12m", "3h", "2d": the row's time since it was held. */
export function ago(/** @type {number} */ t, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "4 minutes ago", for a screen reader. */
export function agoLong(/** @type {number} */ t, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  const say = (/** @type {number} */ v, /** @type {string} */ u) => `${v} ${u}${v === 1 ? "" : "s"} ago`;
  if (m < 1) return "just now";
  if (m < 60) return say(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 48) return say(h, "hour");
  return say(Math.floor(h / 24), "day");
}

/** The two swipe actions of a row, by kind: [right, left]. */
export function swipeActions(/** @type {Item} */ n) {
  if (n.kind === "draft") return n.gate?.kind && n.gate.kind !== "send" ? ["Approve", "Discard"] : ["Send", "Discard"];
  if (n.kind === "question") return ["Answer", "Later"];
  if (n.kind === "pair") return ["Pair", "Deny"];
  return ["Approve", "Deny"];
}

/**
 * The row's accessibility label (section 12): "kit, Harlow Legal, wants to push q3-report, git push
 * origin q3-report, 4 minutes ago. Actions: Approve, Deny, Open."
 * @param {Item} n
 */
export function ariaLabel(n, now = Date.now()) {
  const [a, b] = swipeActions(n);
  const who = n.kind === "pair" ? (n.pair?.name || "A Mac") : (n.agent || (n.kind === "draft" ? "An agent" : "A session"));
  const where = n.kind === "pair" ? null : (n.projectName || n.threadName);
  const t = titleOf(n);
  const want = n.kind === "question" ? "has a question" : n.kind === "pair" ? "wants to pair with this box"
    : `wants to ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  const line = secondLine(n).text;
  const time = n.kind === "pair" ? null : agoLong(n.at, now);
  return `${[who, where, want, n.kind === "pair" ? null : line, time].filter(Boolean).join(", ")}. Actions: ${a}, ${b}, Open.`;
}

/**
 * How this device proves a person is here, for "Approve with Face ID" (section 5).
 * @param {string} ua navigator.userAgent @param {number} [touch] navigator.maxTouchPoints
 */
export function presenceWord(ua, touch = 0) {
  if (/iPhone|iPod/.test(ua)) return "Face ID";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return "Face ID";
  if (/Android/.test(ua)) return "fingerprint";
  if (/Macintosh/.test(ua)) return "Touch ID";
  return "passkey";
}

/**
 * Where Open session goes: the exact session, at the moment it was raised (section 15 anchors).
 * @param {Item} n @returns {string | null}
 */
export function sessionHref(n) {
  const a = n.anchor || {};
  const thread = n.thread || a.thread || null;
  if (!thread) return null;
  const at = Number(a.at || n.at || 0);
  let q = `?at=${encodeURIComponent(String(at))}`;
  if (a.tool_use_id) q += `&tool=${encodeURIComponent(String(a.tool_use_id))}`;
  else if (a.event != null) q += `&event=${encodeURIComponent(String(a.event))}`;
  return `/chat/thread/${encodeURIComponent(thread)}${q}`;
}

/** The commit point and the width of a revealed action, in px (section 4). */
export const ACTION_W = 100;
/** A release this fast (px per ms, toward the open side) is a fling and commits. */
export const FLING = 0.5;

/**
 * What a released swipe does. x is the row's offset (positive: dragged right), v its velocity in
 * px/ms (positive: moving right).
 * @param {number} x @param {number} v
 * @returns {"commit-right"|"open-right"|"commit-left"|"open-left"|"close"}
 */
export function release(x, v) {
  if (x > 0) {
    if (x >= ACTION_W || (v >= FLING && x > 24)) return "commit-right";
    return x >= ACTION_W * 0.4 ? "open-right" : "close";
  }
  if (x < 0) {
    if (-x >= ACTION_W || (-v >= FLING && -x > 24)) return "commit-left";
    return -x >= ACTION_W * 0.4 ? "open-left" : "close";
  }
  return "close";
}

/**
 * A question's answers as threads.answer takes them: { [question]: "label" | "a, b" | "typed" }.
 * Null while any question has nothing chosen and nothing typed.
 * @param {{ question: string, multiSelect?: boolean }[]} questions
 * @param {Map<number, Set<string>>} picked labels chosen per question index
 * @param {Map<number, string>} typed "Something else" text per question index
 * @returns {Record<string, string> | null}
 */
export function questionAnswers(questions, picked, typed) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < questions.length; i++) {
    const text = String(typed.get(i) || "").trim();
    const labels = [...(picked.get(i) || [])];
    const q = questions[i];
    const parts = q.multiSelect ? [...labels, ...(text ? [text] : [])] : text ? [text] : labels.slice(0, 1);
    if (!parts.length) return null;
    out[q.question] = parts.join(", ");
  }
  return out;
}

/**
 * The Changes fact row (section 5 and the queued diff summary): "6 files +412 -38" from totals, or
 * summed from changes; null when there is neither.
 * @param {{ totals?: { files: number, added: number, removed: number }, changes?: { file: string, added: number, removed: number }[] }} x
 */
export function changesLine(x) {
  const t = x?.totals || (Array.isArray(x?.changes) && x.changes.length
    ? x.changes.reduce((s, c) => ({ files: s.files + 1, added: s.added + (Number(c.added) || 0), removed: s.removed + (Number(c.removed) || 0) }), { files: 0, added: 0, removed: 0 })
    : null);
  if (!t) return null;
  return { files: `${t.files} file${t.files === 1 ? "" : "s"}`, counts: `+${t.added} -${t.removed}` };
}

/**
 * Remote and branch of a git push, for the ask sheet's fact rows. Null for anything else.
 * @param {string} cmd
 */
export function pushTarget(cmd) {
  const w = String(cmd || "").trim().split(/\s+/);
  const i = w.indexOf("push");
  if (lastPart(w[0] || "") !== "git" || i < 1) return null;
  const args = w.slice(i + 1).filter(x => !x.startsWith("-"));
  return { remote: args[0] || null, branch: args[1] ? args[1].replace(/^\+/, "").split(":").pop() || null : null };
}
