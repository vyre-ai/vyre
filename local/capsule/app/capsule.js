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
  /** @type {"ask"|"waiting"|"review"|"source"|"reply"} */ mode: "ask",
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
    api.destinations(S.chip, body),
    // Memory answers only for the default destination; an @ is an instruction, not a question.
    !S.chip && body.length >= 3 ? api.recall(body) : null,
  ]);
  if (mine !== seq) return;
  S.dest = dest;
  S.destIndex = Math.min(S.destIndex, dest.options.length - 1);
  S.recall = recall && (recall.answer || (dest.options[0].kind === "recall" && recall.sources.length)) ? recall : null;
  paint();
}
let thinkTimer = 0;
const soon = (ms = 90) => { clearTimeout(thinkTimer); thinkTimer = window.setTimeout(() => think().catch(e => console.error("capsule: " + (e && e.stack || e))), ms); };

function choose(item) {
  const caret = box.selectionStart ?? box.value.length;
  const start = S.comp ? S.comp.start : caret;
  const rest = (box.value.slice(0, Math.max(0, start)) + box.value.slice(caret)).replace(/^\s+/, "");
  S.chip = item; S.comp = null; S.destIndex = 0;
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
  S.sent = { dest: d, text };
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
  Object.assign(S, { mode: "ask", chip: null, text: "", comp: null, dest: null, destIndex: 0, recall: null, review: null, draft: null, summary: "", loading: false, source: null, sent: null, note: "", waitIndex: 0 });
  box.value = "";
  box.placeholder = "Ask, or @agent";
  api.pin(false);
}

// ------------------------------------------------------------------ keys

box.addEventListener("input", () => { S.note = ""; S.takeable = null; if (S.mode !== "reply") S.mode = "ask"; soon(); });

window.addEventListener("keydown", e => {
  const k = e.key;
  if (k === "Escape") {
    e.preventDefault();
    if (S.comp) { S.comp = null; return paint(); }
    // Esc in a field leaves the field; Esc again leaves the hold.
    if (S.mode === "review" && inField()) { /** @type {HTMLElement} */ (document.activeElement).blur(); return; }
    if (S.mode === "review") { S.mode = "waiting"; S.review = null; api.pin(false); return paint(); }
    if (S.mode === "source") { S.mode = "ask"; S.source = null; paint(); return box.focus(); }
    // One press, always the same result: the Capsule goes and the keyboard goes back.
    return api.dismiss();
  }
  if (S.mode === "review") {
    // No single-letter keys here: every line of a draft takes typing, and a letter that
    // discarded the draft would fire mid-word.
    if (k === "Enter" && e.metaKey) { e.preventDefault(); return decide(S.review, S.review.source === "ask" ? "allow" : "send"); }
    if (k === "Enter" && S.review.source === "ask" && !inField()) { e.preventDefault(); return decide(S.review, "allow"); }
    return;
  }
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
  if (k === "Backspace" && S.chip && box.selectionStart === 0 && box.selectionEnd === 0) { e.preventDefault(); S.chip = null; return soon(0); }
  if (k === "ArrowUp" && !box.value && !S.chip && S.snap.waiting.length && S.mode === "ask") { e.preventDefault(); S.mode = "waiting"; S.waitIndex = 0; return paint(); }
  if (S.mode === "reply" && k === "Enter") { e.preventDefault(); return S.sent && send(S.sent.dest); }
  const opts = S.dest ? S.dest.options : [];
  if (k === "ArrowDown" && opts.length > 1 && !S.recall) { e.preventDefault(); S.destIndex = (S.destIndex + 1) % opts.length; return paint(); }
  if (k === "ArrowUp" && opts.length > 1 && !S.recall) { e.preventDefault(); S.destIndex = (S.destIndex - 1 + opts.length) % opts.length; return paint(); }
  if (S.recall) {
    const srcs = S.recall.sources;
    if (k === "ArrowDown" && srcs.length) { e.preventDefault(); S.srcIndex = (S.srcIndex + 1) % srcs.length; return paint(); }
    if (k === "ArrowUp" && srcs.length) { e.preventDefault(); S.srcIndex = (S.srcIndex - 1 + srcs.length) % srcs.length; return paint(); }
    if (k === "Enter" && srcs.length) { e.preventDefault(); return openSource(srcs[S.srcIndex]); }
    if (k === "Tab" && opts[0] && opts[0].kind !== "recall") { e.preventDefault(); return send(opts[0]); }
  }
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
  $("dot").setAttribute("fill", nWait ? "#FF7A59" : "#C6F36B");
  $("chip").hidden = !S.chip;
  if (S.chip) $("chip").textContent = "@" + S.chip.label;
  hint.replaceChildren();

  if (!snap.up) {
    kids.push(h("div", { class: "sect note warn" }, h("span", { class: "lbl" }, "Offline"), "vyred is not running on this Mac. Start it with vyre up. Nothing here is live until it is."));
    keys("esc close");
    return done(panel, kids);
  }

  if (S.mode === "waiting" && nWait) {
    kids.push(h("div", { class: "sect waithead" }, h("span", { class: "lbl" }, `Waiting on you · ${nWait}`), h("span", { class: "s" }, "oldest first")));
    kids.push(h("div", { class: "pad" }, snap.waiting.map((w, i) => h("div", { class: "wait" + (i === S.waitIndex ? " on" : ""), onclick: () => { S.waitIndex = i; openReview(w); } },
      h("span", { class: "b" }), h("span", { class: "c" }, h("span", { class: "t" }, w.title), w.sub ? h("span", { class: "s" }, w.sub) : null),
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
    hint.append(h("span", { class: "badge" }, h("i"), "HELD FOR YOU"));
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
    } else {
      body.push(h("div", { class: "grid" }, w.tool ? [h("span", { class: "k" }, "Tool"), h("span", { class: "v mono" }, w.tool)] : null, w.sub ? [h("span", { class: "k" }, "Where"), h("span", { class: "v" }, w.sub)] : null));
    }
    kids.push(h("div", { class: "sect held" }, body));
    const ask = w.source === "ask";
    kids.push(h("div", { class: "sect actions" },
      h("button", { type: "button", class: "btn btn-primary", onclick: () => decide(w, ask ? "allow" : "send") }, ask ? "Allow" : "Send", h("span", { class: "k" }, ask ? "⏎" : "⌘⏎")),
      h("button", { type: "button", class: "btn btn-ghost quiet", onclick: () => decide(w, ask ? "deny" : "discard") }, ask ? "Deny" : "Discard"),
      w.rule ? h("span", { class: "rule" }, `Rule: ${w.rule}`) : w.why ? h("span", { class: "rule" }, w.why) : null));
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
    const state = !r ? "sending" : r.error ? "failed" : r.finished ? "done" : r.lease && r.lease !== "capsule" ? `${r.lease} is typing` : "replying";
    kids.push(h("div", { class: "sect replyhead" }, h("span", { class: "lbl on" }, "Reply"), h("span", { class: "who" }, [who, ...where].filter(Boolean).join(" · ")), h("span", { class: "state" }, state)));
    kids.push(h("div", { class: "asked" }, S.sent.text));
    if (r && r.tools.length) kids.push(h("div", { class: "tools" }, r.tools.map(t => h("span", { class: "tl" + (t.error ? " fail" : "") }, `${t.done ? (t.error ? "failed" : "done") : "running"} · ${t.summary}`))));
    kids.push(h("div", { class: "reply" }, r && r.text ? r.text : "", r && !r.finished ? h("span", { class: "caret" }) : null));
    if (r && r.error) kids.push(h("div", { class: "sect note warn" }, h("span", { class: "lbl" }, "failed"), r.error));
    if (S.note) kids.push(h("div", { class: "sect note warn" }, S.note));
    keys("⏎ follow up", "esc close");
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

  if (S.recall && S.recall.answer || S.recall && S.dest && S.dest.options[0].kind === "recall") {
    const rc = S.recall;
    hint.append(h("span", { class: "ms" }, `${rc.ms} ms`));
    kids.push(h("div", { class: "sect recall" }, h("span", { class: "lbl" }, "From memory · no model used"),
      rc.answer ? h("div", { class: "answer" }, rc.answer) : h("div", { class: "more" }, "Nothing in memory answers that. These turns mention it."),
      rc.more.length ? h("div", { class: "more" }, rc.more.join(". ") + ".") : null));
    if (rc.sources.length) kids.push(h("div", { class: "sect pad" }, rc.sources.map((s, i) => h("div", { class: "src" + (i === S.srcIndex ? " on" : ""), onclick: () => openSource(s) },
      doc(), h("span", { class: "t" }, s.name), h("span", { class: "s" }, [s.age, `"${s.quote}"`].filter(Boolean).join(" · "))))));
    const ask = S.dest && S.dest.options[0].kind !== "recall" ? S.dest.options[0].agent : null;
    keys(rc.sources.length ? "⏎ open source" : null, ask ? `⇥ ask ${ask} instead` : null, "esc close");
    if (S.note) kids.push(h("div", { class: "sect note warn" }, S.note));
    return done(panel, kids);
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

  // Empty.
  if (nWait) hint.append(h("span", { class: "kbd live" }, "↑"));
  if (nWait) kids.push(h("div", { class: "sect note" }, `${nWait} waiting on you. Press ↑ to see ${nWait === 1 ? "it" : "them"}.`));
  if (!snap.hotkey.ok && snap.hotkey.message && snap.hotkey.message !== "starting") kids.push(h("div", { class: "sect note warn" }, h("span", { class: "lbl" }, "Hotkey"), snap.hotkey.message));
  if (S.note) kids.push(h("div", { class: "sect note warn" }, S.note));
  keys("⏎ ask " + (snap.assistant || "memory"), "@ agent, project or thread", nWait ? "↑ waiting" : null, "esc close");
  return done(panel, kids);
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
api.onOpen(() => {
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
