// @ts-check
// The words and numbers of a Needs you row on the phone (docs/design/phone.md sections 4, 5, 12),
// kept free of the DOM so node:test can check them: the title by kind, the three lines, the
// time, the accessibility label, the Face ID word for this device, where Open session goes, and
// what a released swipe does. deck/js/now-phone.js and deck/js/need-sheet.js draw with these.

/** @typedef {{ kind: string, at: number, id?: string, project?: string|null, rule?: string, destination?: string|null, agent?: string|null, projectName?: string|null, threadName?: string|null, title?: string,
 *   command?: string, tool?: string, detail?: any, questions?: any[], why?: string, thread?: string|null, anchor?: any,
 *   source?: string|null, machine?: string|null, node?: string|null,
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
  const first = String((g.to || [])[0] || "");
  // No name from the Gate: the address's own name part, "dana@harlowlegal.com" as "Dana".
  const local = /^([a-z]+)@/i.exec(first)?.[1];
  const name = g.toName ? String(g.toName).trim().split(/\s+/)[0] : local ? local.charAt(0).toUpperCase() + local.slice(1) : first;
  const what = /mail/i.test(g.via || "") || /@/.test(first) ? "email" : "message";
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

/** Line 3: "<agent> · <project>", and "on <mac>" for a Mac session's. @param {Item} n */
export function thirdLine(n) {
  if (n.kind === "pair") return [n.pair?.node, n.pair?.login].filter(Boolean).join(" · ") || "A Mac asking to pair";
  // Without an agent, the session's own name says who asks.
  const who = n.agent || n.threadName || (n.kind === "draft" ? "an agent" : "a session");
  const where = n.projectName && n.projectName !== who ? n.projectName : n.agent && n.threadName ? n.threadName : null;
  return [who, where, fromMac(n) ? `on ${n.machine || "your Mac"}` : null].filter(Boolean).join(" · ");
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

// ---- a session on the paired Mac (federation v2) -------------------------------------------------
// A Mac session's ask or question (source "mac") is answered from here like any other: threads.answer
// carries its `machine` and the box forwards it (needs.js answer). There is no box flag saying it
// does, so the first refusal that says it cannot (needs.js macRefused) turns forwarding off for the
// rest of the page, and from then on every Mac item says "Answer it on <mac>" instead. The switch
// lives here, not in needs.js, so this file stays free of the DOM and of api.js; needs.js re-exports it.

let forwards = true;
/** Does this box forward answers to the paired Mac (true until a refusal says it does not)? */
export const macAnswers = () => forwards;
/** This box cannot forward answers: every Mac item says where to answer, for the rest of the page. */
export function holdMacAnswers() { forwards = false; }
/** For tests: back to the page's first state. */
export function resetMacAnswers() { forwards = true; }

/** Is this an ask or question from a session on the paired Mac? @param {Item} n */
export const fromMac = n => !!n && n.source === "mac" && (n.kind === "ask" || n.kind === "question");

/**
 * The Mac an ask or question waits on, when it cannot be answered from here: its session runs on
 * the paired Mac and this box has shown it does not forward answers (macAnswers false). Null for
 * every other item, and for every Mac item while answers go through.
 * @param {Item} n @returns {string|null}
 */
export function elsewhere(n) {
  if (!fromMac(n)) return null;
  // waiting says this box cannot answer it (answer.tool null, answer.on the Mac): no buttons.
  if (/** @type {any} */ (n).answerOn) return String(/** @type {any} */ (n).answerOn);
  if (forwards) return null;
  return n.machine ? String(n.machine) : "your Mac";
}

/** The two swipe actions of a row, by kind: [right, left]. A Mac's ask that cannot be answered here has none: [] (it only opens). */
export function swipeActions(/** @type {Item} */ n) {
  if (elsewhere(n)) return [];
  if (n.kind === "draft") return isSend(n) ? ["Send", "Discard"] : ["Approve", "Discard"];
  if (n.kind === "question") return ["Answer", "Later"];
  if (n.kind === "pair") return ["Pair", "Deny"];
  return ["Approve", "Deny"];
}

/** A held item that goes out as a message (the default kind), not a spend or a delete. */
const isSend = (/** @type {Item} */ n) => !n.gate?.kind || n.gate.kind === "send";

/**
 * What committing a swipe does (the no-nag rule): an ask is approved or denied at once, as the
 * owner's own act. A draft goes outside as the person, so a right swipe only opens the sheet on
 * its final words, and Send there proves presence. A question has no one-swipe answer; its left
 * swipe is Later. A Mac asking to pair needs its code, so it opens too.
 * @param {Item} n @param {"right"|"left"} side
 * @returns {"approve"|"deny"|"discard"|"later"|"sheet"}
 */
export function swipeCommit(n, side) {
  if (elsewhere(n)) return "sheet";
  if (side === "right") return n.kind === "ask" ? "approve" : "sheet";
  if (n.kind === "draft") return "discard";
  if (n.kind === "question") return "later";
  return "deny";
}

/** Under the Needs you card until the first swipe. The approve side proves nothing (no-nag). */
export const SWIPE_HINT = "Swipe right to approve, left to deny.";

/**
 * The sheet's primary button. An ask: "Approve" (no proof). A draft: "Send with Face ID" (it goes
 * out as the person), "Send edited" once a field changed, "Approve with Face ID" for a spend or
 * a delete. A question: "Answer". A pair: "Pair with Face ID". While a presence session covers
 * the draft (`covered`, need-sheet.js's coverLine), no Face ID is asked, so it reads just "Send"
 * or "Approve".
 * @param {Item} n @param {string} word presenceWord() @param {boolean} [edited] @param {boolean} [covered]
 */
export function sheetPrimary(n, word, edited = false, covered = false) {
  if (n.kind === "draft") return !isSend(n) ? (covered ? "Approve" : `Approve with ${word}`) : edited ? "Send edited" : covered ? "Send" : `Send with ${word}`;
  if (n.kind === "question") return "Answer";
  if (n.kind === "pair") return `Pair with ${word}`;
  return "Approve";
}

/** The toast after a commit: what happened, and whether Undo is honest for it. */
export function toastFor(/** @type {"approve"|"deny"|"discard"|"later"|"send"|"answer"} */ what) {
  const words = { approve: "Approved", deny: "Denied", discard: "Discarded", later: "Hidden here for an hour", send: "Sent", answer: "Answered" };
  return { text: words[what] || "Done", undo: what === "deny" || what === "discard" || what === "later" };
}

/** "Held 4 min", "Held 2 h", "Held 3 days": the sheet's third row. */
export function heldFor(/** @type {number} */ t, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return "Held just now";
  if (m < 60) return `Held ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `Held ${h} h`;
  const d = Math.floor(h / 24);
  return `Held ${d} day${d === 1 ? "" : "s"}`;
}

/** The sheet's first row: "kit asks · Harlow Legal". */
export function sheetWho(/** @type {Item} */ n) {
  if (n.kind === "pair") return [n.pair?.name || "A Mac", "wants to pair"].join(" ");
  const who = n.agent || (n.kind === "draft" ? "An agent" : "A session");
  return [`${who} asks`, n.projectName || n.threadName].filter(Boolean).join(" · ");
}

/**
 * An ask's fact rows (section 5): Remote and Branch for a push, Changes when the box sent a diff
 * summary, Where for a destination, Held by for the rule or reason that stopped it.
 * @param {Item & { destination?: string|null, rule?: string, totals?: any, changes?: any[] }} n
 * @returns {{ label: string, value: string, counts?: string }[]}
 */
export function factRows(n) {
  /** @type {{ label: string, value: string, counts?: string }[]} */
  const out = [];
  const cmd = String(n.detail?.command || n.command || "");
  const push = pushTarget(cmd);
  if (push?.remote) out.push({ label: "Remote", value: push.remote });
  if (push?.branch) out.push({ label: "Branch", value: push.branch });
  const ch = changesLine({ totals: n.detail?.totals || n.totals, changes: n.detail?.changes || n.changes });
  if (ch) out.push({ label: "Changes", value: ch.files, counts: ch.counts });
  // Where, unless the command block already says it (an Edit's file, a fetch's URL).
  const shown = String(n.detail?.command || n.detail?.file || n.detail?.url || n.command || "");
  if (n.destination && !push && String(n.destination) !== shown && !shown.includes(String(n.destination))) out.push({ label: "Where", value: String(n.destination) });
  if (n.rule) out.push({ label: "Held by", value: `Your rule: ${n.rule}` });
  return out;
}

/**
 * A call that waits out its Undo toast: `run` goes after `ms` unless `cancel` comes first, and
 * `flush` sends it at once (the page is being left, or the next commit needs the toast). Each
 * resolves once: a cancelled one never runs, a run one cannot be cancelled.
 * @param {() => any} run @param {number} ms
 * @param {{ setTimeout: (f: () => void, ms: number) => any, clearTimeout: (t: any) => void }} [timers]
 */
export function deferred(run, ms, timers = globalThis) {
  let state = /** @type {"waiting"|"ran"|"cancelled"} */ ("waiting");
  /** @type {(v: any) => void} */ let settle = () => {};
  const done = new Promise(r => { settle = r; });
  const go = () => {
    if (state !== "waiting") return;
    state = "ran";
    timers.clearTimeout(t);
    Promise.resolve().then(run).then(v => settle({ ran: true, value: v }), e => settle({ ran: true, error: e }));
  };
  const t = timers.setTimeout(go, ms);
  return {
    done,
    get state() { return state; },
    cancel() { if (state !== "waiting") return false; state = "cancelled"; timers.clearTimeout(t); settle({ ran: false }); return true; },
    flush: go,
  };
}

/** How long Later hides a question on this device. */
export const LATER_MS = 3_600_000;

/**
 * Later, on this device only: threads.answer's deny is a decline, so Later answers nothing. It
 * hides the question here for an hour, in localStorage (every read and write guarded: a private
 * window can throw), and it shows again after that or on another device.
 * @param {Pick<Storage, "getItem"|"setItem">|null} store @param {string} [key]
 */
export function snoozes(store, key = "vyre.needs.later") {
  const read = () => { try { const v = JSON.parse(store?.getItem(key) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
  const write = (/** @type {Record<string, number>} */ v) => { try { store?.setItem(key, JSON.stringify(v)); } catch {} };
  return {
    /** Hide one until now + LATER_MS. */
    snooze(/** @type {string} */ id, now = Date.now()) { const v = read(); v[id] = now + LATER_MS; write(v); },
    /** Show it again (Undo). */
    wake(/** @type {string} */ id) { const v = read(); delete v[id]; write(v); },
    /** Is it hidden right now? Expired entries are dropped as they are read. */
    has(/** @type {string} */ id, now = Date.now()) {
      const v = read();
      let dirty = false;
      for (const [k, until] of Object.entries(v)) if (!(Number(until) > now)) { delete v[k]; dirty = true; }
      if (dirty) write(v);
      return id in v;
    },
  };
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
  const acts = a && b ? `Actions: ${a}, ${b}, Open.` : `Answer it on ${elsewhere(n)}. Actions: Open.`;
  return `${[who, where, want, n.kind === "pair" ? null : line, time].filter(Boolean).join(", ")}. ${acts}`;
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
 * Where Open session goes: the exact session in Chat, at the moment it was raised (section 15
 * anchors). Chat's routes are /chat/<project>/<thread> and /chat/thread/<thread> (chat/lib/routes.js),
 * and chat/session.js reads ?at=<ms>&ask=<id>&tool=<tool_use_id>: an ask's card or its tool call
 * wins, else the first row at or after `at`. A held draft has no ask id, so it lands by tool or time.
 * @param {Item & { id?: string, project?: string|null }} n @returns {string | null}
 */
export function sessionHref(n) {
  const a = n.anchor || {};
  const thread = n.thread || a.thread || null;
  if (!thread) return null;
  const enc = encodeURIComponent;
  const path = n.project ? `/chat/${enc(n.project)}/${enc(thread)}` : `/chat/thread/${enc(thread)}`;
  const q = [`at=${enc(String(Number(a.at || n.at || 0)))}`];
  if ((n.kind === "ask" || n.kind === "question") && n.id) q.push(`ask=${enc(n.id)}`);
  if (a.tool_use_id) q.push(`tool=${enc(String(a.tool_use_id))}`);
  return `${path}?${q.join("&")}`;
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
