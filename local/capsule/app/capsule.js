// @ts-check
// The Capsule page. It draws what the main process says is true and asks it for everything
// else; it has no Node and no socket. Four states from the board (typing, recall, held, waiting)
// plus the two the board implies: @ being completed, and a reply streaming back.
//
// Rules this file keeps:
//   - The destination shows before anything is sent (floor rule 2), and Enter sends to exactly
//     the destination on screen: the send takes the object that was drawn, not a new guess.
//   - Only the user's gesture puts the caret in the box (onOpen). State arriving never does.
//   - Nothing is removed on optimism. An answered hold leaves when vyred says it is answered.
//   - Every repaint is from state; the box itself is never rewritten while the user types in it.

/** @type {any} */
const api = /** @type {any} */ (window).vyre;
const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
const box = /** @type {HTMLInputElement} */ ($("box"));

/** @param {string} tag @param {Record<string, any>} [props] @param {...any} kids */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const doc = () => h("span", { class: "i" }, svg(`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#EBC76B" stroke-width="1.5" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M6 8h4M6 11h4"/></svg>`));
function svg(markup) { const t = document.createElement("template"); t.innerHTML = markup; return /** @type {Node} */ (t.content.firstChild); }

const S = {
  /** @type {"ask"|"waiting"|"review"|"source"|"reply"|"report"|"actions"|"code"} */ mode: "ask",
  /** @type {any} */ snap: { up: false, waiting: [], reply: null, has: {}, assistant: null, hotkey: { ok: true, message: "" } },
  /** @type {any} */ chip: null,
  text: "",
  /** @type {{ items: any[], index: number, start: number }|null} */ comp: null,
  /** @type {any} */ dest: null, destIndex: 0,
  /** @type {any} */ recall: null,
  waitIndex: 0,
  /** @type {any} */ review: null, /** @type {any} */ draft: null, summary: "", loading: false,
  /** @type {any} */ source: null, srcIndex: 0,
  /** @type {any} */ sent: null,
  note: "",
  /** @type {any} */ takeable: null,
  /** @type {any} */ report: null,
  /** @type {any} */ acts: null, /** @type {any} */ code: null,
  // What a bare query finds on this Mac, ranked with Vyre's own. `sel` runs over the results and
  // then the ask row, which is always last: results.length means "send it".
  /** @type {any[]} */ results: [], intent: "ask",
  // The highlighted row, by key ("ask:0", or a result id), so a list that grows (files landing)
  // keeps the same row highlighted. null means the default: the first row.
  /** @type {string|null} */ selKey: null,
  /** @type {Record<string, string>} */ iconMap: {},
  // The words S.dest was worked out for. Ask rows show only when they match the box, so Enter can
  // never send to a destination drawn for what the box said a moment ago (floor rule 2).
  destFor: "",
  typedAt: 0,
  busy: false,
};
let seq = 0;

// ------------------------------------------------------------------ what the box means

async function think() {
  const mine = ++seq;
  const text = box.value;
  S.text = text;
  const m = S.chip ? { completing: null, items: [] } : await api.mention(text, box.selectionStart ?? text.length);
  if (mine !== seq) return;
  if (m.completing !== null) {
    S.comp = { items: m.items, index: 0, start: m.start };
    S.dest = null; S.recall = null;
    return paint();
  }
  S.comp = null;
  const body = text.trim();
  if (!body && !S.chip) { S.dest = null; S.recall = null; return paint(); }
  const [dest, recall] = await Promise.all([
    S.snap.up ? api.destinations(S.chip, body) : null,
    // Memory answers only for the default destination; an @ is an instruction, not a question.
    !S.chip && body.length >= 3 && S.snap.up ? api.recall(body) : null,
  ]);
  if (mine !== seq) return;
  if (!S.chip) {
    // Files take hundreds of milliseconds; they join the list when they land, if the box has not moved on.
    api.full(body).then(f => { if (f && mine === seq && box.value.trim() === body) { showResults(f, "files"); paint(); } });
  }
  if (!dest) { S.dest = null; S.recall = null; return paint(); }
  S.dest = dest;
  S.destFor = body;
  S.destIndex = Math.min(S.destIndex, dest.options.length - 1);
  // A fact, or what the user said in a session about the same words: either is worth showing, and
  // what shows here is what a quick question sends along (bridge quickAppend).
  S.recall = recall && (recall.answer || recall.sources.length) ? recall : null;
  // A name to open wins over memory; a question is for memory and the assistant.
  if (S.intent === "open") S.recall = null;
  paint();
}

/**
 * Local results on every keystroke, with no debounce: they are answered in the main process from
 * memory and the helper in a few milliseconds, and a launcher that waits for typing to pause
 * feels slow. vyred (destinations, memory) and mdfind wait for the pause in think().
 */
let lookSeq = 0;
async function look() {
  const mine = ++lookSeq;
  const body = box.value.trim();
  if (S.chip || !body || S.comp || /(^|\s)@\S*$/.test(box.value)) { if (!body || S.chip) S.results = []; return; }
  const found = await api.quick(body);
  if (mine !== lookSeq || box.value.trim() !== body) return;
  showResults(found);
  if (S.intent === "open") S.recall = null;
  paint();
  timed("results");
}

/** Take a ranked list, keeping the highlighted row where it was if it is still there. */
function showResults(found, why) {
  S.results = found ? found.results : [];
  S.intent = found ? found.intent : "ask";
  // New words, new default; files landing for the same words keep what the user moved to.
  if (why !== "files") S.selKey = null;
  if (why === "files") requestAnimationFrame(() => timed("files"));
}

/**
 * The rows of a bare query, in order: where the words could be sent ("ask" rows, each naming its
 * destination, floor rule 2) and what they found on this Mac and in Vyre. A question with no
 * strong match puts the ask rows first; a name to open puts the results first.
 * @returns {{ key: string, ask?: any, r?: any }[]}
 */
function entries() {
  const up = S.snap.up;
  const asks = up && S.dest && !S.chip && S.destFor === box.value.trim() ? S.dest.options.filter(d => d.kind !== "recall").map((d, i) => ({ key: "ask:" + i, ask: d })) : [];
  const res = S.results.map(r => ({ key: r.id, r }));
  return S.intent === "open" ? [...res, ...asks] : [...asks, ...res];
}

/**
 * Which row Enter takes. The default is the first row, never the contacts offer: picking it
 * raises a macOS dialog, so that happens only when the user moves to it on purpose.
 */
function selected(E = entries()) {
  const i = S.selKey == null ? -1 : E.findIndex(e => e.key === S.selKey);
  if (i >= 0) return i;
  return E.findIndex(e => !e.r || e.r.kind !== "grant");
}

/** How long from the keystroke to this frame, for the numbers the proposal asks for. */
function timed(kind) {
  const at = S.typedAt;
  if (!at) return;
  requestAnimationFrame(() => api.timing({ kind, ms: performance.now() - at, n: S.results.length }));
}

/** The verbs a module offers on one of its results, as a list to choose from. */
async function openActions(r) {
  const acts = await api.actions(r);
  if (!acts.length) return;
  S.acts = { r, list: acts, index: 0 }; S.mode = "actions";
  paint();
}

/** Run one verb. What the module says is shown as it is; a one-time code counts down. */
async function act(r, key) {
  S.note = "";
  S.busy = true; paint();
  const out = await api.act(r, key);
  S.busy = false;
  // The Capsule stepped aside for it; the result went out as a notification.
  if (out.hidden) { S.mode = "ask"; S.acts = null; return; }
  if (out.error) { S.note = out.error; S.mode = "ask"; return paint(); }
  if (out.code) { S.code = { label: r.label, code: String(out.code), period: Number(out.period) || 30, until: Date.now() + (Number(out.remaining) || 0) * 1000, said: out.said || "" }; S.mode = "code"; tickCode(); return paint(); }
  S.note = out.said || "Done."; S.mode = "ask";
  paint();
}

let codeTimer = 0;
/** Repaint the countdown once a second, only while the code is on screen. */
function tickCode() {
  clearInterval(codeTimer);
  codeTimer = window.setInterval(() => { if (S.mode !== "code") return clearInterval(codeTimer); paint(); }, 1000);
}

/** Open a local result, or make a Vyre one the chip, the way @ would. */
async function pickResult(r, { take = false } = {}) {
  if (r.kind === "agent" || r.kind === "project" || r.kind === "thread") {
    box.value = ""; S.results = []; S.selKey = null;
    return choose(r);
  }
  if (r.kind === "module") {
    // Enter runs the module's first verb (for the vault: fill the front app). ⌘K lists the rest.
    const acts = await api.actions(r);
    if (!acts.length) { S.note = "Nothing to do with it here."; return paint(); }
    return act(r, acts[0].key);
  }
  if (r.kind === "drive") {
    const d = { kind: "thread", thread: r.target, threadLabel: r.thread, meta: "", show: { who: r.thread, where: [] } };
    const sent = await api.send(d, r.text, { take });
    // Someone else has that thread's keyboard. Taking it is the user's call: ⌘⏎, never ours.
    if (sent.error) { S.note = sent.error + (sent.holder ? " ⌘⏎ takes the keyboard." : ""); S.takeable = sent.holder ? { drive: r } : null; return paint(); }
    await api.watch(r.target, r.thread);
    S.note = `Sent to ${r.thread}. A notification says when it is done or asks.`;
    box.value = ""; S.results = []; S.selKey = null;
    return paint();
  }
  if (r.kind === "watch") {
    const label = r.label.replace(/^Watch /, "");
    await api.watch(r.target, label);
    S.note = `Watching ${label}. A notification says when it is done or asks.`;
    box.value = ""; S.results = []; S.selKey = null;
    return paint();
  }
  const r2 = await api.pick(r, box.value.trim());
  S.note = r2.error || r2.note || "";
  paint();
}
/** Send a file on this Mac to the box. It can take a while, so the note says so first, then how it went. */
let sending = false;
async function sendFile(r) {
  if (sending) return;
  sending = true;
  S.note = `Sending ${r.label} to the box…`;
  paint();
  const out = await api.sendFile(r).catch(e => ({ error: String(e && e.message || e) }));
  sending = false;
  S.note = out.error || out.note || "";
  paint();
}
let thinkTimer = 0;
const soon = (ms = 90) => { clearTimeout(thinkTimer); thinkTimer = window.setTimeout(() => think().catch(e => console.error("capsule: " + (e && e.stack || e))), ms); };

function choose(item) {
  const caret = box.selectionStart ?? box.value.length;
  const start = S.comp ? S.comp.start : caret;
  const rest = (box.value.slice(0, Math.max(0, start)) + box.value.slice(caret)).replace(/^\s+/, "");
  S.chip = item; S.comp = null; S.destIndex = 0;
  // @ an agent is a conversation: its history shows, and replies stream into it.
  if (item.kind === "agent") api.dmOpen(item.id); else api.dmClose();
  box.value = rest;
  box.setSelectionRange(rest.length, rest.length);
  soon(0);
}

// ------------------------------------------------------------------ doing

async function send(d, { take = false } = {}) {
  const text = box.value.trim();
  if (!text || S.busy) return;
  S.busy = true; S.note = ""; S.takeable = null;
  const r = await api.send(d, text, { take });
  S.busy = false;
  if (r.error) {
    // Someone else has the keyboard in that thread. Taking it is the user's call, never ours.
    S.note = r.error + (r.holder ? " ⌘⏎ takes the keyboard." : "");
    S.takeable = r.holder ? d : null;
    return paint();
  }
  S.sent = { dest: d, text, thread: r.thread || null };
  // "<name> is busy in your terminal. I'll hand it your message when this turn ends."
  if (r.queued && r.note) S.note = r.note;
  if (inDm()) { box.value = ""; S.text = ""; box.placeholder = `Message ${S.chip.label}`; return paint(); }
  S.mode = "reply";
  box.value = ""; S.text = "";
  box.placeholder = "Follow up";
  paint();
}

async function openSource(ref) {
  const r = await api.source(ref);
  if (r.error) { S.note = r.error; return paint(); }
  S.source = r; S.mode = "source";
  paint();
}

async function decide(item, decision) {
  if (S.busy || S.loading) return;
  S.busy = true; S.note = "";
  // Send sends exactly what is on screen. What changed is passed as `edited`, so the Gate sends
  // the user's words and Learning sees the correction (spec 7.11).
  const r = await api.answer(item, decision, decision === "send" ? changes() : undefined);
  S.busy = false;
  if (r.error) { S.note = r.error; return paint(); }
  S.review = null; S.draft = null; api.pin(false);
  S.mode = S.snap.waiting.length ? "waiting" : "ask";
  S.waitIndex = 0;
  paint();
  if (S.mode === "ask") box.focus();
}

function reset() {
  seq++;
  Object.assign(S, { mode: "ask", chip: null, text: "", comp: null, dest: null, destIndex: 0, recall: null, review: null, draft: null, summary: "", loading: false, source: null, sent: null, note: "", waitIndex: 0, results: [], intent: "ask", selKey: null, typedAt: 0, destFor: "" });
  box.value = "";
  box.placeholder = "Ask, or @agent";
  api.pin(false);
  api.dmClose();
}

// ------------------------------------------------------------------ keys

box.addEventListener("input", () => { S.typedAt = performance.now(); S.note = ""; S.takeable = null; if (S.mode !== "reply") S.mode = "ask"; look(); soon(); });

window.addEventListener("keydown", e => {
  const k = e.key;
  if (k === "Escape") {
    e.preventDefault();
    if (S.comp) { S.comp = null; return paint(); }
    // Esc in a field leaves the field; Esc again leaves the hold.
    if (S.mode === "review" && inField()) { /** @type {HTMLElement} */ (document.activeElement).blur(); return; }
    if (S.mode === "review") { S.mode = "waiting"; S.review = null; api.pin(false); return paint(); }
    if (S.mode === "source") { S.mode = "ask"; S.source = null; paint(); return box.focus(); }
    if (S.mode === "report") { S.mode = "ask"; S.report = null; paint(); return box.focus(); }
    if (S.mode === "actions" || S.mode === "code") { S.mode = "ask"; S.acts = null; S.code = null; paint(); return box.focus(); }
    // An answer still streaming: the first Esc stops it and keeps what came; the next one closes.
    // Words still queued for a terminal session: the first Esc takes them back (bridge unqueue).
    if (S.mode === "reply" && S.snap.reply && !S.snap.reply.finished) { api.cancel().then(r => { if (r && r.note) { S.note = r.note; paint(); } }); return; }
    // One press, always the same result: the Capsule goes and the keyboard goes back.
    return api.dismiss();
  }
  if (S.mode === "review") {
    // No single-letter keys here: every line of a draft takes typing, and a letter that
    // discarded the draft would fire mid-word.
    const yesNo = S.review.source === "ask" || S.review.source === "lesson";
    if (k === "Enter" && e.metaKey) { e.preventDefault(); return decide(S.review, yesNo ? "allow" : "send"); }
    if (k === "Enter" && yesNo && !inField()) { e.preventDefault(); return decide(S.review, "allow"); }
    return;
  }
  if (S.mode === "actions" && S.acts) {
    const n = S.acts.list.length;
    if (k === "ArrowDown") { e.preventDefault(); S.acts.index = (S.acts.index + 1) % n; return paint(); }
    if (k === "ArrowUp") { e.preventDefault(); S.acts.index = (S.acts.index - 1 + n) % n; return paint(); }
    if (k === "Enter") { e.preventDefault(); return act(S.acts.r, S.acts.list[S.acts.index].key); }
    return;
  }
  if (S.mode === "code") return;
  if (S.mode === "waiting") {
    const n = S.snap.waiting.length;
    if (k === "ArrowDown") { e.preventDefault(); S.waitIndex = (S.waitIndex + 1) % n; return paint(); }
    if (k === "ArrowUp") { e.preventDefault(); if (S.waitIndex === 0) { S.mode = "ask"; return paint(); } S.waitIndex--; return paint(); }
    if (k === "Enter") { e.preventDefault(); return openReview(S.snap.waiting[S.waitIndex]); }
    if (k === "a" || k === "A") { e.preventDefault(); return decide(S.snap.waiting[S.waitIndex], "allow"); }
    return;
  }
  if (S.comp && S.comp.items.length) {
    const n = S.comp.items.length;
    if (k === "ArrowDown") { e.preventDefault(); S.comp.index = (S.comp.index + 1) % n; return paint(); }
    if (k === "ArrowUp") { e.preventDefault(); S.comp.index = (S.comp.index - 1 + n) % n; return paint(); }
    if (k === "Enter" || k === "Tab") { e.preventDefault(); return choose(S.comp.items[S.comp.index]); }
    return;
  }
  if (S.mode === "source") {
    if (k === "Enter") { e.preventDefault(); S.mode = "ask"; S.source = null; paint(); box.focus(); }
    return;
  }
  if (k === "Backspace" && S.chip && box.selectionStart === 0 && box.selectionEnd === 0) { e.preventDefault(); if (S.chip.kind === "agent") api.dmClose(); S.chip = null; return soon(0); }
  if (k === "ArrowUp" && !box.value && !S.chip && S.snap.waiting.length && S.mode === "ask") { e.preventDefault(); S.mode = "waiting"; S.waitIndex = 0; return paint(); }
  if (S.mode === "reply" && k === "Enter") { e.preventDefault(); return S.sent && send(followUp(S.sent)); }
  const opts = S.dest ? S.dest.options : [];
  // Typed faster than the destination could be worked out: work it out and show it, send nothing.
  if (k === "Enter" && S.mode === "ask" && S.snap.up && (box.value.trim() || S.chip) && S.destFor !== box.value.trim()) { e.preventDefault(); return soon(0); }
  const E = !S.chip && S.mode === "ask" && box.value.trim() && !S.comp ? entries() : [];
  if (E.length) {
    const i = selected(E);
    if (k === "ArrowDown") { e.preventDefault(); S.selKey = E[(i + 1) % E.length].key; return paint(); }
    if (k === "ArrowUp") { e.preventDefault(); S.selKey = E[i <= 0 ? E.length - 1 : i - 1].key; return paint(); }
    const cur = i >= 0 ? E[i] : null;
    if (cur && cur.r && cur.r.kind === "module" && (k === "ArrowRight" || (k === "k" && e.metaKey))) { e.preventDefault(); return openActions(cur.r); }
    // Tab always asks, whatever is highlighted: the one key that sends the words on.
    if (k === "Tab" && opts[0] && opts[0].kind !== "recall") { e.preventDefault(); return send(opts[0]); }
    // ⌥⏎ on a file on this Mac sends it to the box (Taildrop); ⏎ still opens it.
    if (k === "Enter" && e.altKey && cur && cur.r && cur.r.kind === "file" && S.snap.has.send) { e.preventDefault(); return sendFile(cur.r); }
    if (k === "Enter" && !e.metaKey && i >= 0) {
      e.preventDefault();
      const it = E[i];
      return it.ask ? send(it.ask) : pickResult(it.r);
    }
  }
  if (k === "ArrowDown" && opts.length > 1 && !S.recall) { e.preventDefault(); S.destIndex = (S.destIndex + 1) % opts.length; return paint(); }
  if (k === "ArrowUp" && opts.length > 1 && !S.recall) { e.preventDefault(); S.destIndex = (S.destIndex - 1 + opts.length) % opts.length; return paint(); }
  if (S.recall) {
    const srcs = S.recall.sources;
    if (k === "ArrowDown" && srcs.length) { e.preventDefault(); S.srcIndex = (S.srcIndex + 1) % srcs.length; return paint(); }
    if (k === "ArrowUp" && srcs.length) { e.preventDefault(); S.srcIndex = (S.srcIndex - 1 + srcs.length) % srcs.length; return paint(); }
    if (k === "Enter" && srcs.length) { e.preventDefault(); return openSource(srcs[S.srcIndex]); }
    if (k === "Tab" && opts[0] && opts[0].kind !== "recall") { e.preventDefault(); return send(opts[0]); }
  }
  if (k === "Enter" && e.metaKey && S.takeable && S.takeable.drive) { e.preventDefault(); const r = S.takeable.drive; S.takeable = null; return pickResult(r, { take: true }); }
  if (k === "Enter" && e.metaKey && S.takeable) { e.preventDefault(); return send(S.takeable, { take: true }); }
  if (k === "Enter" && opts.length) { e.preventDefault(); return send(opts[S.destIndex]); }
  // Tab means something only where the footer says so; elsewhere it must not move focus out of
  // the box and select its text.
  if (k === "Tab") e.preventDefault();
});

// ------------------------------------------------------------------ drawing

function destRow(d, on, label) {
  const { who, where } = d.show;
  const parts = [];
  where.forEach((w, i) => { parts.push(h("span", { class: "sep" }, i === 0 ? "·" : "›")); parts.push(h("span", { class: "where" + (i === where.length - 1 ? " last" : "") }, w)); });
  return h("div", { class: "dest" + (on ? " on" : "") }, h("span", { class: "lbl" }, label), h("span", { class: "who" }, who), parts, h("span", { class: "meta" }, d.meta));
}

function keys(...items) {
  const el = $("keys");
  el.replaceChildren(...items.filter(Boolean).map(t => h("span", {}, t)));
}

function paint() {
  const snap = S.snap;
  const panel = $("panel");
  const hint = $("hint");
  const kids = [];
  const nWait = snap.waiting.length;
  // A proposed lesson waits quietly: it never turns the dot Beacon on its own.
  const loud = snap.waitingLoud ?? nWait;
  $("dot").setAttribute("fill", loud ? "#FF7A59" : "#C6F36B");
  $("chip").hidden = !S.chip;
  if (S.chip) $("chip").textContent = "@" + S.chip.label;
  hint.replaceChildren();

  if (!snap.up) {
    // This Mac's own results still work (floor rule 9); only Vyre's are gone.
    if (S.results.length && box.value.trim()) {
      kids.push(...entryRows(entries()));
      kids.push(h("div", { class: "sect note warn" }, h("span", { class: "lbl" }, "Offline"), "vyred is not running, so nothing can be sent. Results here are from this Mac."));
      if (S.note) kids.push(h("div", { class: "sect note" }, S.note));
      keys("↑↓ move", "⏎ open", "esc close");
      return done(panel, kids);
    }
    kids.push(h("div", { class: "sect note warn" }, h("span", { class: "lbl" }, "Offline"), "vyred is not running on this Mac. Start it with vyre up. Nothing here is live until it is."));
    keys("esc close");
    return done(panel, kids);
  }

  if (S.mode === "actions" && S.acts) {
    const a = S.acts;
    kids.push(h("div", { class: "sect replyhead" }, h("span", { class: "lbl on" }, a.r.provider || a.r.module), h("span", { class: "who" }, a.r.label)));
    kids.push(h("div", { class: "sect pad" }, a.list.map((x, i) => h("div", { class: "row res" + (i === a.index ? " on" : ""), onmousedown: ev => { ev.preventDefault(); act(a.r, x.key); } },
      glyph(a.r.module === "vault" ? "vault" : "file"), h("span", { class: "t" }, x.title), h("span", { class: "acc" }, i === a.index ? "⏎" : "")))));
    if (S.busy) kids.push(h("div", { class: "sect note" }, "Waiting for the vault. Touch ID may ask first."));
    keys("↑↓ move", "⏎ run", "esc back");
    return done(panel, kids);
  }

  if (S.mode === "code" && S.code) {
    const c = S.code;
    const left = Math.max(0, Math.round((c.until - Date.now()) / 1000));
    kids.push(h("div", { class: "sect replyhead" }, h("span", { class: "lbl on" }, "One-time code"), h("span", { class: "who" }, c.label), h("span", { class: "state" }, left ? `${left} s` : "expired")));
    kids.push(h("div", { class: "code" }, left ? c.code.replace(/^(\d{3})(\d{3})$/, "$1 $2") : "Expired. Ask for it again."));
    if (c.said) kids.push(h("div", { class: "sect note" }, c.said));
    keys("esc back");
    return done(panel, kids);
  }

  if (S.mode === "waiting" && nWait) {
    kids.push(h("div", { class: "sect waithead" }, h("span", { class: "lbl" }, `Waiting on you · ${nWait}`), h("span", { class: "s" }, "oldest first")));
    kids.push(h("div", { class: "pad" }, snap.waiting.map((w, i) => h("div", { class: "wait" + (i === S.waitIndex ? " on" : ""), onclick: () => { S.waitIndex = i; openReview(w); } },
      h("span", { class: "b" + (w.quiet ? " quiet" : "") }), h("span", { class: "c" }, h("span", { class: "t" }, w.title), w.sub ? h("span", { class: "s" }, w.sub) : null),
      h("span", { class: "a" }, w.age), i === S.waitIndex ? h("span", { class: "kbd" }, "⏎") : null))));
    keys("↑↓ move", "⏎ review", "A allow", "esc close");
    return done(panel, kids);
  }

  if (S.mode === "review" && S.review) {
    const w = S.review;
    // Repainting would rebuild the fields under the caret. Once the card for this hold is drawn,
    // only its note changes; the words are the user's until they send or leave.
    const key = `${w.source}:${w.id}:${S.loading ? "loading" : "ready"}`;
    if (panel.dataset.review === key) { const n = panel.querySelector(".heldnote"); if (n) n.textContent = S.note; return; }
    hint.append(w.source === "lesson" ? h("span", { class: "badge quiet" }, "VYRE PROPOSES") : h("span", { class: "badge" }, h("i"), "HELD FOR YOU"));
    box.hidden = true;
    $("chip").hidden = true;
    const field = /** @type {HTMLElement} */ (box.parentElement);
    field.querySelector(".heldtitle")?.remove();
    field.append(h("span", { class: "heldtitle" }, w.title));
    const d = S.draft;
    const body = [];
    if (d) {
      body.push(h("div", { class: "grid" },
        h("span", { class: "k" }, "To"), editable("to", "v mono"),
        h("span", { class: "k" }, "Subject"), editable("subject", "v")));
      body.push(editable("body", "body"));
      body.push(h("div", { class: "howto" }, "Click any line to change it. ⌘⏎ sends what you see. Esc leaves a field."));
    } else if (S.loading) {
      body.push(h("div", { class: "howto" }, "Opening the draft…"));
    } else if (w.source === "gate") {
      // Not mail (an http call, a payment): shown as the Gate summarised it, approved as it is.
      body.push(h("div", { class: "grid" }, w.to ? [h("span", { class: "k" }, "To"), h("span", { class: "v mono" }, w.to)] : null,
        w.via ? [h("span", { class: "k" }, "Via"), h("span", { class: "v mono" }, w.via)] : null));
      if (S.summary) body.push(h("div", { class: "body" }, S.summary));
    } else if (w.source === "lesson") {
      body.push(h("div", { class: "body lesson" }, w.rule || ""));
      // scope is "all" or {project} or {agent}; state.js has already put it in words.
      body.push(h("div", { class: "grid" }, w.where ? [h("span", { class: "k" }, "Where"), h("span", { class: "v" }, w.where)] : null,
        w.from ? [h("span", { class: "k" }, "From"), h("span", { class: "v" }, w.from)] : null));
    } else {
      body.push(h("div", { class: "grid" }, w.tool ? [h("span", { class: "k" }, "Tool"), h("span", { class: "v mono" }, w.tool)] : null, w.sub ? [h("span", { class: "k" }, "Where"), h("span", { class: "v" }, w.sub)] : null));
    }
    kids.push(h("div", { class: "sect held" }, body));
    const ask = w.source === "ask" || w.source === "lesson";
    const yes = w.source === "lesson" ? "Accept" : ask ? "Allow" : "Send", no = w.source === "lesson" ? "Decline" : ask ? "Deny" : "Discard";
    kids.push(h("div", { class: "sect actions" },
      h("button", { type: "button", class: "btn btn-primary", onclick: () => decide(w, ask ? "allow" : "send") }, yes, h("span", { class: "k" }, ask ? "⏎" : "⌘⏎")),
      h("button", { type: "button", class: "btn btn-ghost quiet", onclick: () => decide(w, ask ? "deny" : "discard") }, no),
      w.rule && w.source !== "lesson" ? h("span", { class: "rule" }, `Rule: ${w.rule}`) : w.why ? h("span", { class: "rule" }, w.why) : null));
    kids.push(h("div", { class: "heldnote note warn" }, S.note));
    $("keys").hidden = true;
    done(panel, kids);
    panel.dataset.review = key;
    return null;
  }
  delete panel.dataset.review;
  box.hidden = false;
  box.parentElement?.querySelector(".heldtitle")?.remove();
  $("keys").hidden = false;

  if (S.mode === "source" && S.source) {
    const src = S.source;
    kids.push(h("div", { class: "sect recall" }, h("span", { class: "lbl" }, "Source · " + src.name)));
    for (const t of src.turns) kids.push(h("div", { class: "turn" }, h("span", { class: "lbl" + (t.seq === src.seq ? " on" : "") }, t.role === "user" ? "You" : "Claude"), h("span", { class: "x" + (t.seq === src.seq ? " on" : "") }, t.text)));
    keys("⏎ back", "esc back");
    return done(panel, kids);
  }

  if (S.mode === "reply" && S.sent) {
    const r = snap.reply;
    const { who, where } = S.sent.dest.show;
    const stopped = r && r.error === "stopped";
    const state = !r ? "sending" : r.queued && r.queued.withdrawn ? "taken back" : stopped ? "stopped" : r.error ? "failed" : r.finished ? "done" : r.queued && !r.text ? (r.queued.delivered ? "handed over" : "queued")
      : r.lease && r.lease !== "capsule" ? `${r.lease} is typing` : "answering";
    // What it cost, small: the model, the dollars the switchboard reported, the time.
    const cost = r && r.finished ? [r.model, r.cost != null ? `$${Number(r.cost).toFixed(3)}` : null, r.ms ? `${(r.ms / 1000).toFixed(1)} s` : null].filter(Boolean).join(" · ") : "";
    // The user's words first, as theirs; then who answers, and the answer under it.
    kids.push(h("div", { class: "sect asked" }, h("span", { class: "lbl" }, "You"), h("span", { class: "q" }, S.sent.text)));
    kids.push(h("div", { class: "sect replyhead" }, h("span", { class: "lbl on" }, who || "Answer"), h("span", { class: "who" }, where.filter(Boolean).join(" · ")),
      h("span", { class: "state" }, cost || state)));
    const mem = r && r.memory && (r.memory.memo || []).length ? r.memory : null;
    if (mem) kids.push(memoBox(mem));
    // Queued for a session busy in a terminal: it gets the words when its turn ends (harness Stop).
    if (r && r.queued && !r.text && !r.finished) kids.push(h("div", { class: "sect status" }, r.queued.delivered ? `Handed to ${r.queued.name}. Its reply shows here as it comes.` : `Queued for ${r.queued.name}: it gets this when its current turn ends.`));
    if (r && r.tools.length) kids.push(h("div", { class: "tools" }, r.tools.map(t => h("span", { class: "tl" + (t.error ? " fail" : "") }, `${t.done ? (t.error ? "failed" : "done") : "running"} · ${t.summary}`))));
    kids.push(h("div", { class: "reply md" }, r && r.text ? md(r.text) : null, r && !r.finished && !(r.queued && !r.text) ? h("span", { class: "caret" }) : null));
    // Vyre's own words (a usage limit), faint, under the answer and never in it.
    if (r && r.notice) kids.push(h("div", { class: "sect status" }, r.notice));
    if (r && r.finished && r.text) kids.push(h("div", { class: "sect replyacts" },
      h("button", { type: "button", class: "btn btn-ghost", onclick: async () => { await api.copy(r.text); S.note = "Copied."; paint(); } }, "Copy"),
      S.sent.dest.kind === "quick" && !S.sent.dest.deep && S.dest ? deeperButton() : null));
    if (r && r.error && !stopped) kids.push(h("div", { class: "sect note warn" }, h("span", { class: "lbl" }, "failed"), r.error));
    if (S.note) kids.push(h("div", { class: "sect note" }, S.note));
    keys("⏎ follow up", r && !r.finished ? "esc stop" : "esc close");
    const el = /** @type {HTMLElement|null} */ (document.querySelector(".reply"));
    done(panel, kids);
    const rep = /** @type {HTMLElement|null} */ (document.querySelector(".reply"));
    if (rep) rep.scrollTop = rep.scrollHeight;
    return el;
  }

  if (S.comp) {
    const items = S.comp.items;
    if (!items.length) kids.push(h("div", { class: "sect note" }, "No agent, project or thread by that name."));
    else kids.push(h("div", { class: "sect pad" }, items.map((c, i) => h("div", { class: "row" + (i === S.comp?.index ? " on" : ""), onmousedown: e => { e.preventDefault(); choose(c); } },
      h("span", { class: "lbl kind" }, c.kind), h("span", { class: "t" }, c.label), h("span", { class: "s" }, c.sub)))));
    if (!snap.has.agents) kids.push(h("div", { class: "why" }, "Agents appear here once the switchboard runs on this vyred."));
    keys("↑↓ move", "⏎ choose", "esc close");
    return done(panel, kids);
  }

  // Memory on its own: only when nothing can be asked (no assistant, no Claude) and nothing found.
  if ((S.recall && S.recall.answer || S.recall && S.dest && S.dest.options[0].kind === "recall" && S.recall.sources.length) && !(!S.chip && entries().length)) {
    const rc = S.recall;
    hint.append(h("span", { class: "ms" }, `${rc.ms} ms`));
    kids.push(memoBox(rc, " · no model used", S.srcIndex));
    if (rc.more.length) kids.push(h("div", { class: "sect recall" }, h("div", { class: "more" }, rc.more.join(". ") + ".")));
    const ask = S.dest && S.dest.options[0].kind !== "recall" ? S.dest.options[0].agent : null;
    keys(rc.sources.length ? "⏎ open source" : null, ask ? `⇥ ask ${ask} instead` : null, "esc close");
    if (S.note) kids.push(h("div", { class: "sect note warn" }, S.note));
    return done(panel, kids);
  }

  const E = !S.chip && box.value.trim() && !S.comp ? entries() : [];
  if (E.length) {
    const opts = S.dest ? S.dest.options : [];
    kids.push(...entryRows(E));
    if (S.dest && S.dest.why && E[0].ask) kids.push(h("div", { class: "why" }, S.dest.why));
    if (S.note) kids.push(h("div", { class: "sect note" }, S.note));
    const cur = E[selected(E)];
    const primary = opts[0] && opts[0].kind !== "recall" ? opts[0].show.who : null;
    keys("↑↓ move", !cur ? null : cur.ask ? "⏎ send" : cur.r.kind === "calc" ? "⏎ copy" : cur.r.kind === "clip" ? "⏎ copy, then ⌘V" : cur.r.kind === "clipclear" ? "⏎ clear" : cur.r.kind === "watch" ? "⏎ watch" : cur.r.kind === "module" ? (cur.r.module === "vault" ? "⏎ fill, ⌘K more" : "⏎ run, ⌘K more") : cur.r.kind === "drive" ? "⏎ send and watch" : cur.r.kind === "grant" ? "⏎ allow contacts" : "⏎ open",
      cur && cur.r && cur.r.kind === "file" && S.snap.has.send ? "⌥⏎ send to box" : null,
      primary && !(cur && cur.ask === opts[0]) ? `⇥ ask ${primary}` : null, "esc close");
    done(panel, kids);
    loadIcons();
    return null;
  }

  if (inDm()) {
    kids.push(...dmView(snap.dm));
    const opts = S.dest && S.destFor === box.value.trim() ? S.dest.options : [];
    if (box.value.trim() && opts.length) kids.push(h("div", { class: "sect pad" }, opts.map((d, i) => destRow(d, i === S.destIndex, i === S.destIndex ? "Sends to" : "Or"))));
    if (S.note) kids.push(h("div", { class: "sect note warn" }, S.note));
    keys(box.value.trim() ? "⏎ send" : null, snap.dm.asks.length ? "click an ask to answer" : null, "⌫ leave", "esc close");
    const list = /** @type {HTMLElement|null} */ (document.querySelector(".dm"));
    done(panel, kids);
    const el = /** @type {HTMLElement|null} */ (document.querySelector(".dm"));
    if (el && (!list || list.scrollTop + list.clientHeight >= list.scrollHeight - 8)) el.scrollTop = el.scrollHeight;
    return null;
  }

  if (S.dest && (box.value.trim() || S.chip)) {
    const opts = S.dest.options;
    hint.append(h("span", { class: "kbd" }, "⏎"));
    const rows = opts.map((d, i) => destRow(d, i === S.destIndex, i === S.destIndex ? "Sends to" : "Or"));
    const tail = [];
    if (S.dest.why) tail.push(h("div", { class: "why" }, S.dest.why));
    if (opts[0].kind === "recall") tail.push(h("div", { class: "why" }, "Nothing in memory answers that yet, and there is no assistant on this vyred to ask."));
    if (S.dest.unavailable) tail.push(h("div", { class: "why" }, S.dest.unavailable));
    kids.push(h("div", { class: "sect pad" }, rows, tail));
    if (S.note) kids.push(h("div", { class: "sect note warn" }, S.note));
    keys(opts[0].kind === "recall" ? null : "⏎ send", opts.length > 1 ? "↓ other destination" : null, "esc close");
    return done(panel, kids);
  }

  if (S.mode === "report" && S.report) {
    const r = S.report;
    kids.push(h("div", { class: "sect replyhead" }, h("span", { class: "lbl on" }, WHY[r.why] || "Report"), h("span", { class: "who" }, r.label),
      h("span", { class: "state" }, [r.cost != null ? `$${Number(r.cost).toFixed(3)}` : null, age(r.at)].filter(Boolean).join(" · "))));
    kids.push(h("div", { class: "reply md" }, r.text ? md(r.text) : r.why === "finished" ? "It finished its turn." : ""));
    keys("esc back");
    return done(panel, kids);
  }

  // Empty.
  const reports = snap.reports || [];
  if (reports.length) kids.push(h("div", { class: "sect pad" }, reports.slice(0, 4).map(r => h("div", { class: "row res", onmousedown: e => { e.preventDefault(); openReport(r); } },
    glyph(r.why === "asked" ? "held" : "thread"), h("span", { class: "t" }, `${r.label} · ${(WHY[r.why] || "").toLowerCase()}`),
    h("span", { class: "s" }, (r.text || "").replace(/\s+/g, " ").slice(0, 90)), h("span", { class: "acc" }, age(r.at))))));
  const watching = snap.watching || [];
  if (watching.length) kids.push(h("div", { class: "sect note" }, `Watching ${watching.map(w => w.label).join(", ")}.`));
  if (nWait) hint.append(h("span", { class: "kbd live" }, "↑"));
  if (nWait) kids.push(h("div", { class: "sect note" }, `${nWait} waiting on you. Press ↑ to see ${nWait === 1 ? "it" : "them"}.`));
  // How this Mac reaches the box: a dot, green direct, amber relayed, grey unknown, with the line as its title.
  if (snap.link) {
    const line = [snap.link.path, snap.link.handshake].filter(Boolean).join(", ");
    kids.push(h("div", { class: "sect note boxlink" }, h("span", { class: "lbl" }, "Box"),
      h("span", { class: "hdot " + (snap.link.dot || "unknown"), title: line, role: "img", "aria-label": `Connection to the box: ${line}` })));
  }
  if (!snap.hotkey.ok && snap.hotkey.message && snap.hotkey.message !== "starting") kids.push(h("div", { class: "sect note warn" }, h("span", { class: "lbl" }, "Hotkey"), snap.hotkey.message));
  if (S.note) kids.push(h("div", { class: "sect note warn" }, S.note));
  keys("⏎ ask " + (snap.assistant || "memory"), "@ agent, project or thread", nWait ? "↑ waiting" : null, "esc close");
  return done(panel, kids);
}

/**
 * The rows of a bare query: each with its picture, its name, where or what it is, and a quiet
 * accessory on the right (its kind, or the key that takes it). An ask row names its destination
 * before anything is sent (floor rule 2). Memory, when it answers, sits above in gold.
 */
function entryRows(E) {
  const on = selected(E);
  const rc = S.recall && (S.recall.memo || []).length ? S.recall : null;
  const rows = E.map((e, i) => {
    const sel = i === on;
    const pick = ev => { ev.preventDefault(); S.selKey = e.key; return e.ask ? send(e.ask) : pickResult(e.r); };
    if (e.ask) {
      const d = e.ask;
      const label = d.kind === "quick" ? (d.deep ? "Ask Claude, deeper" : "Ask Claude") : `Ask ${d.show.who}`;
      return h("div", { class: "row res ask" + (sel ? " on" : ""), onmousedown: pick },
        glyph(d.kind === "quick" ? "quick" : d.kind === "assistant" ? "assistant" : d.kind === "agent" ? "agent" : "thread"),
        h("span", { class: "t" }, label), h("span", { class: "s" }, d.show.where.length ? d.show.where.join(" › ") : d.meta),
        h("span", { class: "acc" }, sel ? "⏎" : i === 0 || e.key === "ask:0" ? "⇥" : ""));
    }
    const r = e.r;
    return h("div", { class: "row res" + (r.kind === "calc" ? " calc" : "") + (sel ? " on" : ""), onmousedown: pick },
      picture(r), h("span", { class: "t" }, r.label), r.sub ? h("span", { class: "s" }, r.sub) : null,
      h("span", { class: "acc" }, sel ? (r.kind === "calc" ? "copy ⏎" : r.kind === "module" ? "⌘K ⏎" : "⏎") : r.kind === "module" ? r.provider || r.module : KIND_LABEL[r.kind] ?? r.kind));
  });
  const out = [];
  if (rc) out.push(memoBox(rc, " · no model used"));
  out.push(h("div", { class: "sect pad" }, rows));
  return out;
}
const KIND_LABEL = { calc: "", app: "App", setting: "Settings", file: "File", folder: "Folder", contact: "Contact", define: "Dictionary", grant: "Contacts",
  agent: "Agent", project: "Project", thread: "Thread", memory: "Memory", vault: "Vault", boxfile: "Box", clip: "Clipboard", clipclear: "", watch: "Watch", drive: "Thread", glass: "Glass" };

// ------------------------------------------------------------------ pictures

/** Kinds whose picture comes from macOS through the helper. Everything else is drawn here. */
const FROM_MAC = new Set(["app", "file", "folder", "setting", "contact"]);

/**
 * A result's picture: always the same 24px box, so nothing moves when an icon arrives. Until then
 * a quiet tile (or a contact's initials) holds the place.
 */
function picture(r) {
  if (r.kind === "module") return glyph(r.module === "vault" ? "vault" : "file");
  if (!FROM_MAC.has(r.kind)) return glyph(r.kind);
  const url = r.icon || S.iconMap[r.id] || "";
  const box_ = h("span", { class: "ic mac" + (url ? " has" : "") + (r.kind === "contact" ? " round" : "") });
  if (r.kind === "contact" && !url) box_.append(h("span", { class: "ini" }, initials(r.label)));
  const img = h("img", { alt: "", "data-icon": r.id, draggable: "false" });
  if (url) img.setAttribute("src", url);
  img.addEventListener("load", () => box_.classList.add("has"));
  box_.append(img);
  return box_;
}

const initials = name => String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";

/** Ask for the pictures the rows on screen are missing, then set them in place: no repaint. */
let iconAsk = 0;
async function loadIcons() {
  const want = S.results.filter(r => FROM_MAC.has(r.kind) && !r.icon && !S.iconMap[r.id]);
  if (!want.length) return;
  const mine = ++iconAsk;
  const got = await api.icons(want.map(r => ({ kind: r.kind, id: r.id, label: r.label, target: r.target })));
  Object.assign(S.iconMap, got || {});
  if (mine !== iconAsk && !got) return;
  for (const img of document.querySelectorAll("img[data-icon]")) {
    const url = S.iconMap[/** @type {HTMLElement} */ (img).dataset.icon || ""];
    if (url && img.getAttribute("src") !== url) img.setAttribute("src", url);
  }
}

// One drawing per Vyre kind, on the 16 grid, in Bone on a Raised tile. Memory is Recall gold,
// anything held is Beacon, the assistant and quick answers carry the Signal dot.
const GLYPHS = {
  agent: `<circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5c.6-2.6 2.4-4 4.5-4s3.9 1.4 4.5 4"/>`,
  assistant: `<circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5c.6-2.6 2.4-4 4.5-4s3.9 1.4 4.5 4"/><circle cx="13" cy="3" r="1.6" fill="#C6F36B" stroke="none"/>`,
  project: `<path d="M2 4.5h4l1.5 1.5H14v7H2z"/>`,
  thread: `<path d="M3 4.5l3 3.5-3 3.5"/><path d="M8 11.5h5"/>`,
  memory: `<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M6 8h4M6 11h4"/>`,
  vault: `<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>`,
  boxfile: `<rect x="2.5" y="3" width="11" height="4" rx="1"/><rect x="2.5" y="9" width="11" height="4" rx="1"/><path d="M5 5h.01M5 11h.01"/>`,
  held: `<circle cx="8" cy="8" r="3" fill="#FF7A59" stroke="none"/>`,
  glass: `<rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M6 14h4M8 11v3"/>`,
  quick: `<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2L12 12M12 4l-1.8 1.8M5.8 10.2L4 12"/>`,
  define: `<path d="M3 13V3.5A1.5 1.5 0 0 1 4.5 2H13v9H4.5A1.5 1.5 0 0 0 3 12.5 1.5 1.5 0 0 0 4.5 14H13"/>`,
  grant: `<circle cx="6" cy="6" r="2.2"/><path d="M2.5 13c.4-2 1.8-3.2 3.5-3.2S9.1 11 9.5 13"/><path d="M12 6v4M10 8h4"/>`,
  calc: `<path d="M4 6h8M4 10h8"/>`,
  file: `<path d="M4 1.5h5l3 3v10H4z"/>`,
  drive: `<path d="M3 4.5l3 3.5-3 3.5"/><path d="M8 11.5h5"/><circle cx="13" cy="4" r="1.6" fill="#C6F36B" stroke="none"/>`,
  watch: `<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>`,
  clip: `<rect x="3.5" y="2.5" width="9" height="12" rx="1.5"/><path d="M6 2.5V1.5h4v1M6 7h4M6 10h3"/>`,
  clipclear: `<rect x="3.5" y="2.5" width="9" height="12" rx="1.5"/><path d="M6 7l4 4M10 7l-4 4"/>`,
};
const TONE = { memory: "#EBC76B", held: "#FF7A59", quick: "#C6F36B", calc: "#C6F36B" };

function glyph(kind) {
  const inner = GLYPHS[kind] || GLYPHS.file;
  const stroke = TONE[kind] || "#F1EEE6";
  return h("span", { class: "ic vy" + (kind === "memory" ? " gold" : kind === "held" ? " hot" : "") },
    svg(`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`));
}

// ------------------------------------------------------------------ watches

const WHY = { finished: "Done", failed: "Failed", stopped: "Stopped", asked: "Asking" };

/** "3 min ago" for a report. */
function age(at) {
  const m = Math.round((Date.now() - Number(at || 0)) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

/** Read a report: what the watched thread said last, and it leaves the list. */
function openReport(r) {
  S.report = r; S.mode = "report";
  api.reportRead(r.id);
  paint();
}

// ------------------------------------------------------------------ direct messages

/** A DM is open for the agent in the chip. */
function inDm() {
  const d = S.snap.dm;
  return Boolean(S.chip && S.chip.kind === "agent" && d && S.mode === "ask" && String(d.agent).toLowerCase() === String(S.chip.id).toLowerCase());
}

/** The conversation: history, the reply streaming into it, and the agent's asks in Beacon. */
function dmView(d) {
  const out = [];
  const state = d.loading ? "loading" : d.holder && d.holder !== "capsule" ? `${d.holder} has the keyboard` : d.busy ? "working" : "";
  out.push(h("div", { class: "sect replyhead" }, h("span", { class: "lbl on" }, "Direct"), h("span", { class: "who" }, d.agent), h("span", { class: "state" }, state)));
  const msgs = d.messages.slice(-20);
  const list = h("div", { class: "dm" }, msgs.length ? msgs.map(m => h("div", { class: "msg " + m.role + (m.pending ? " pending" : "") },
    h("span", { class: "lbl" }, m.role === "user" ? (m.surface && m.surface !== "capsule" ? `You · ${m.surface}` : "You") : d.agent),
    m.tools && m.tools.length ? h("div", { class: "tools" }, m.tools.map(t => h("span", { class: "tl" + (t.error ? " fail" : "") }, `${t.done ? (t.error ? "failed" : "done") : "running"} · ${t.summary}`))) : null,
    h("div", { class: "x md" }, m.role === "agent" ? md(m.text || "") : m.text, m.role === "agent" && !m.done && !m.error ? h("span", { class: "caret" }) : null)))
    : h("div", { class: "x empty" }, d.loading ? "" : `Nothing with ${d.agent} yet. What you send starts it.`));
  out.push(list);
  if (d.notice) out.push(h("div", { class: "sect status" }, d.notice));
  if (d.asks.length) out.push(h("div", { class: "sect pad" }, d.asks.map(w => h("div", { class: "wait", onclick: () => openReview(w) },
    h("span", { class: "b" }), h("span", { class: "c" }, h("span", { class: "t" }, w.title), w.sub ? h("span", { class: "s" }, w.sub) : null), h("span", { class: "a" }, w.age || "")))));
  return out;
}

/**
 * What memory has on these words, drawn from the bridge's memoItems: the distilled fact first,
 * then each source, a transcript line as a quote ("You said, 2 weeks ago: ...") and never as a
 * fact. Only quotes: it is "From your sessions". A quick question sends exactly these lines.
 * `on` highlights one source, for the arrow keys in the memory-only view.
 */
function memoBox(m, tail = "", on = -1) {
  const items = m.memo || [];
  // A line made from the user's own words is still from their sessions, not Memory's.
  const label = (m.answer && m.answerKind !== "said" ? "From memory" : "From your sessions") + tail;
  const srcs = (m.sources || []).slice(0, 3);
  return h("div", { class: "sect recall memo" }, h("span", { class: "lbl" }, label), items.map(it => {
    // Items and sources cross IPC as separate copies: match by the turn, not the object.
    const i = it.source ? srcs.findIndex(x => x.session === it.source.session && x.seq === it.source.seq) : -1;
    const open = it.source ? () => openSource(it.source) : null;
    const where = it.source ? h("span", { class: "srcl" + (i >= 0 && i === on ? " on" : ""), onclick: open }, doc(), it.source.name, srcMeta(it.kind === "quote" ? { age: "" } : it)) : null;
    if (it.kind === "quote") return h("div", { class: "said" }, h("span", { class: "who" }, `${it.who} said${it.age ? ", " + ago(it.age) : ""}: `), h("span", { class: "q" }, `"${it.text}"`), where);
    return h("div", { class: it === items[0] && m.answer ? "answer" : "fact" }, it.text, where || srcMeta(it));
  }));
}

/** "2 weeks ago", "just now": the bridge's ago(), for the page. */
const ago = a => (!a ? "" : a === "now" ? "just now" : `${a} ago`);

/** How old a memory is and how sure it is, beside its source: "3 days · 82%". */
function srcMeta(s) {
  const bits = [s.age || null, s.confidence != null ? `${Math.round(Number(s.confidence) * 100)}%` : null].filter(Boolean);
  return bits.length ? h("span", { class: "srcm" }, bits.join(" · ")) : null;
}

// ------------------------------------------------------------------ answers

/** Where a follow-up goes: a quick answer's own thread, else the same destination. */
function followUp(sent) {
  if (sent.dest.kind === "quick" && sent.thread) return { kind: "thread", thread: sent.thread, show: sent.dest.show, meta: sent.dest.meta };
  return sent.dest;
}

/** Ask the same words again, of the deeper model. One press, and the button says which model. */
function deeperButton() {
  const deep = S.dest && S.dest.options.find(d => d.kind === "quick" && d.deep);
  if (!deep) return null;
  return h("button", { type: "button", class: "btn btn-ghost", onclick: () => { box.value = S.sent.text; send(deep); } }, deep.model ? `Deeper · ${deep.model}` : "Deeper");
}

/**
 * Markdown to DOM, for answers. Built node by node, never through innerHTML, so nothing a model
 * writes can become markup or script. Links show their text and where they point; they do not
 * navigate the Capsule.
 */
function md(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text).replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      frag.append(h("pre", {}, h("code", {}, code.join("\n"))));
      continue;
    }
    const head = /^(#{1,3})\s+(.*)$/.exec(line);
    if (head) { frag.append(inline(h("div", { class: "mh h" + head[1].length }), head[2])); i++; continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const list = h(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) list.append(inline(h("li"), lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, "")));
      frag.append(list);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      frag.append(inline(h("blockquote"), q.join(" ")));
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,3}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
    frag.append(inline(h("p"), para.join(" ")));
  }
  return frag;
}

/** `code`, **bold**, *italic*, [text](url), into `el`. */
function inline(el, text) {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) el.append(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) el.append(h("code", {}, t.slice(1, -1)));
    else if (m[2]) el.append(h("strong", {}, t.slice(2, -2)));
    else if (m[3]) el.append(h("em", {}, t.slice(1, -1)));
    else { const l = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t); el.append(h("span", { class: "link", title: l ? l[2] : "" }, l ? l[1] : t)); }
    last = m.index + t.length;
  }
  if (last < text.length) el.append(text.slice(last));
  return el;
}

/** One line of a held draft, editable in place. It reads as text until focused. */
function editable(name, cls) {
  const el = h("span", { class: cls + " edit", contenteditable: "plaintext-only", spellcheck: "true", role: "textbox", "aria-label": name,
    oninput: e => { S.draft[name] = /** @type {HTMLElement} */ (e.target).innerText; } }, S.draft[name] || "");
  // To and Subject are one line: Enter would put a newline in an address.
  if (name !== "body") el.addEventListener("keydown", e => { if (e.key === "Enter" && !e.metaKey) e.preventDefault(); });
  return el;
}

const inField = () => Boolean(document.activeElement && /** @type {HTMLElement} */ (document.activeElement).isContentEditable);

/** Open a hold. A Gate hold's words come from gate.get; a question has none to edit. */
async function openReview(w) {
  Object.assign(S, { review: w, mode: "review", note: "", draft: null, loading: w.source === "gate" });
  api.pin(true);
  paint();
  if (w.source !== "gate") return;
  const r = await api.held(w.id);
  if (S.review !== w) return;
  S.loading = false;
  if (r.error) S.note = r.error;
  else {
    S.draft = r.draft ? { ...r.draft } : null;
    S.summary = r.summary;
    // It was approved before and the sender failed; it is back, as the user last left it.
    if (r.error) S.note = `The last send failed: ${r.error}`;
  }
  paint();
}

/**
 * Every field on screen, changed or not: another surface may have revised the hold since the card
 * opened, and Send must send what this card shows. The Gate diffs the result against the agent's
 * draft, so Learning only sees a correction when there was one.
 */
function changes() {
  if (!S.draft) return undefined;
  // The Gate takes recipients as a list.
  return { to: String(S.draft.to || "").split(/[,;\n]/).map(x => x.trim()).filter(Boolean), subject: S.draft.subject || "", body: S.draft.body || "" };
}

function done(panel, kids) {
  panel.replaceChildren(...kids);
  return null;
}

// The window follows the Capsule's height. The page never sizes itself by the window, so this
// cannot feed back into the layout that caused it (the prototype's resize loop).
new ResizeObserver(() => api.size(/** @type {HTMLElement} */ ($("cap")).offsetHeight)).observe($("cap"));

api.onState(s => {
  S.snap = s;
  if (S.mode === "waiting" && !s.waiting.length) S.mode = "ask";
  if (S.mode === "review" && S.review && !s.waiting.some(w => w.id === S.review.id && w.source === S.review.source)) { S.review = null; S.mode = s.waiting.length ? "waiting" : "ask"; api.pin(false); }
  S.waitIndex = Math.min(S.waitIndex, Math.max(0, s.waiting.length - 1));
  paint();
});
api.onOpen(d => {
  // Two frames after the page hears it, the Capsule is on screen: that is "keypress to visible".
  if (d && d.at) requestAnimationFrame(() => requestAnimationFrame(() => api.timing({ kind: "open:" + d.via, ms: Date.now() - d.at })));
  // Opened by the user: a fresh Capsule with the caret in the box. A reply still streaming is
  // kept, since coming back to read it is the point of opening it again.
  if (!(S.mode === "reply" && S.snap.reply && !S.snap.reply.finished)) reset();
  paint();
  box.focus();
  // Wake-latency instrumentation (SPEC.md 2.8, see main.js's wakeStart comment). rAF only runs
  // once the browser is about to present a frame, so it is the honest "this actually painted"
  // signal for a window that's shown/hidden rather than reloaded. A second nested rAF waits one
  // more frame so the paint() above (a synchronous DOM write, not yet composited) is guaranteed
  // flushed before the ping goes out — a single rAF can fire just ahead of that composite.
  requestAnimationFrame(() => requestAnimationFrame(() => api.paintPing()));
});
api.snapshot().then(s => { S.snap = s; paint(); });
// Files from the box, when they land: only for the words still in the box.
api.onMore(m => { if (m && m.found && box.value.trim() === String(m.text).trim() && S.mode === "ask" && !S.chip) { showResults(m.found, "files"); paint(); } });
// A notification the user clicked: open that report.
api.onReport(id => { const r = (S.snap.reports || []).find(x => x.id === id); if (r) openReport(r); });
