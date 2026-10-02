// @ts-check
// Block renderers for the session view: recall.transcript's blocks (contract 2) as DOM. A reply's
// text is markdown (lib/markdown.js, never parsed as markup), thinking is folded under
// "Thinking", and each tool call is a card that knows its tool: Bash shows the command and what
// it printed, an edit shows a unified diff, a write a preview of the new file, a read the first
// lines, a search a compact list, a fetch its link, a todo list its checklist, anything else its
// input as keys and values. A live card (built from thread.tool's summary before the transcript
// has the call) is the same card with less in it, and becomes the rich one in place.
//
// Every visual is a cv- class in chat.css ("session view" section), so a restyle is CSS only.
// Nothing here uses innerHTML: every string is a text node.

import { h, add, put } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { madeNow, unmark } from "./core/made.js";
import { icon } from "../js/icons.js";
import { personAvatar, assistantAvatar, agentAvatar, teammateAvatar, teammateId } from "../js/avatars.js";
import { clock } from "../js/fmt.js";
import { providerMark, providerName, badgeSize } from "../js/provider-mark.js";
import { renderMarkdown } from "./lib/markdown.js";
import { renderUnified, renderRows, patchRows } from "./lib/diff.js";
import { highlight } from "./lib/highlight.js";
import { clip, commandText, duration, elapsed, langOf, rawLines, shortPath, toolState, toolTitle, toolVerb, turnParts } from "./lib/blocks.js";
import { dataUrl, humanSize, inlineable, tooLarge, THUMB } from "./core/images.js";
import { openLightbox } from "./lightbox.js";
import { toolDisplay } from "./cards/index.js";

const OUTPUT_LINES = 12;
/** Bash shows this much of what it printed before "show all". */
const BASH_LINES = 6;
/** An edit's diff opens on its own up to this many lines. */
const DIFF_OPEN = 30;

/** Whether a card starts open: the checklist and a run always, an edit when its diff is short,
 * a new file's preview; reads, searches and the rest open on a tap. A failure always opens. */
function opensByDefault(b) {
  if (b.error) return true;
  const i = b.input || {};
  if (b.tool === "TodoWrite" || b.tool === "Bash" || b.tool === "Write") return true;
  const lines = s => String(s ?? "").split("\n").length;
  if (b.tool === "Edit") return lines(i.old_string) + lines(i.new_string) <= DIFF_OPEN;
  if (b.tool === "MultiEdit") return (Array.isArray(i.edits) ? i.edits : []).reduce((n, e) => n + lines(e.old_string) + lines(e.new_string), 0) <= DIFF_OPEN;
  return false;
}

/** The person's avatar beside "you" (or another of their surfaces): the person family (js/avatars.js). */
export function personAv(who, me) {
  return personAvatar({ size: 24, title: who === "you" && me ? me : who, cls: "av-person msg-av cv-av" });
}

/** The avatar beside a reply: the assistant's creature (whatever it is called), else the agent's
 * blob, or a teammate's character when team.list knows its id (js/avatars.js). */
export function agentAv(who, assistant = who === "Vyre") {
  if (assistant) return assistantAvatar({ size: 24, title: who, cls: "av-agent msg-av cv-av cv-av-vyre" });
  return agentAvatar(String(who), { size: 24, title: who, cls: "av-agent msg-av cv-av" });
}

/** A row's kind, for the header rule (lib/blocks.js plan): user, assistant, turn, or card. */
const tag = (el, kind, ts) => { /** @type {any} */ (el)._kind = kind; /** @type {any} */ (el)._ts = ts ?? null; return el; };

/**
 * A thumbnail, fixed to `size` (THUMB by default) so it never shifts the rows around it while the
 * picture decodes (interaction.md section 1: never a layout jump). A tap opens the full picture
 * (lightbox.js). `context`: who sent it, or which tool - joined with the picture's own name when
 * it has one. Exported for session.js's sight strip (a step's screen), the same shape as any other
 * picture, at its own smaller size (chat.css sets a caller's size by class, never by overriding
 * this inline style, which always wins on the same element).
 * @param {import("./core/images.js").Picture} p @param {string} [context] @param {{ w: number, h: number }} [size]
 */
export function pictureThumb(p, context, size = THUMB) {
  const src = dataUrl(p);
  const caption = p.name && context ? `${p.name} - ${context}` : p.name || context || "";
  return h("button", { class: "cv-pic", type: "button", style: `--pic-w:${size.w}px;--pic-h:${size.h}px`,
    "aria-label": p.name ? `Open ${p.name}` : "Open picture", onclick: () => openLightbox(src, { alt: p.name || "", caption }) },
    h("img", { class: "cv-pic-img", src, alt: "", loading: "lazy" }));
}

/** A picture too large to inline (core/images.js's INLINE_LIMIT_BYTES): a plain file line, not a link yet. */
function fileChip(p) {
  return h("span", { class: "cv-pic-file" }, icon("file", 14), p.name || "Picture", p.size ? h("span", { class: "faint" }, humanSize(p.size)) : null);
}

/**
 * "you" (or a surface's name) and the words, as a chat message. `images`: the attachments that
 * went with it. An array (this device's own, or a step's still) draws real thumbnails; a bare
 * number (an older read, or another device's send: the box does not echo the bytes back) falls
 * back to a plain count, as before.
 * @param {string} who @param {string} text @param {number|null} ts @param {string|null} me
 * @param {number|import("./core/images.js").Picture[]} [images]
 */
export function userRow(who, text, ts, me = null, images = 0) {
  const list = Array.isArray(images) ? images : [];
  const inline = inlineable(list), big = tooLarge(list);
  const count = Array.isArray(images) ? list.length : images;
  return tag(h("div", { class: "msg cv-row cv-user" },
    personAv(who, me),
    h("div", { class: "msg-body" },
      h("div", { class: "msg-head" }, h("span", { class: "msg-who" }, who), ts ? h("span", { class: "msg-when" }, clock(ts)) : null),
      h("div", { class: "msg-text cv-user-text" }, String(text ?? "")),
      inline.length ? h("div", { class: "cv-user-images" }, inline.map(p => pictureThumb(p, `from ${who}`))) : null,
      big.length ? h("div", { class: "cv-user-images" }, big.map(fileChip)) : null,
      !list.length && count > 0 ? h("div", { class: "cv-user-images faint" }, count === 1 ? "1 image" : `${count} images`) : null),
  ), "user", ts);
}

/** The header an assistant run starts with: the assistant's name (or the agent's) and the time.
 * `av`: the avatar to wear (session.js passes js/avatars.js threadAvatar: the project's tile, a
 * chat's draft tile, an agent or teammate, or the assistant); without it, agentAv's. */
export function headRow(who, ts, assistant = who === "Vyre", av = null, prov = null) {
  const avatar = av || agentAv(who, assistant);
  const wrap = h("span", { class: "msg-av-wrap" }, avatar);
  const meta = h("span", { class: "msg-prov" });
  const row = /** @type {any} */ (tag(h("div", { class: "cv-row cv-head" },
    wrap,
    h("span", { class: "msg-who" }, who),
    meta,
    ts ? h("span", { class: "msg-when" }, clock(ts)) : null,
  ), "assistant", ts));
  /** Which AI account wrote this run: the badge at the avatar's lower right and "Provider, model" beside the name. Nothing without a provider. @param {{ provider?: string|null, model?: string|null }|null} p */
  row.setProv = p => {
    wrap.querySelector(".pmark")?.remove();
    meta.replaceChildren();
    if (!p || !p.provider) return;
    const badge = providerMark(p.provider, badgeSize(24), { model: p.model });
    if (badge) { badge.classList.add("pmark-on-av"); wrap.append(badge); }
    meta.append([providerName(p.provider), p.model].filter(Boolean).join(", "));
  };
  row.setProv(prov);
  return row;
}

/** Assistant text as markdown. */
export function textRow(text, ts) {
  const el = h("div", { class: "cv-row cv-text msg-text" });
  add(el, renderMarkdown(text));
  return tag(el, "assistant", ts);
}

/**
 * A reply still streaming: text grows, markdown re-renders at most every `every` ms, a cursor
 * sits at the end until done() is called.
 * @returns {HTMLElement & { push: (delta: string) => void, set: (text: string) => void, done: () => void, text: () => string }}
 */
export function liveTextRow(ts, every = 120) {
  const el = /** @type {any} */ (tag(h("div", { class: "cv-row cv-text msg-text cv-live" }), "assistant", ts));
  let text = "", timer = null, finished = false;
  const draw = () => {
    timer = null;
    el.replaceChildren();
    add(el, renderMarkdown(text));
    if (!finished) {
      // The cursor goes inside the last paragraph when there is one, so it sits after the words.
      const last = el.lastElementChild && /^(P|LI|H\d)$/.test(el.lastElementChild.tagName) ? el.lastElementChild : el;
      last.append(h("span", { class: "msg-cursor" }));
    }
  };
  const soon = () => { if (!timer) timer = setTimeout(draw, every); };
  el.push = d => { text += d; soon(); };
  el.set = t => { text = String(t ?? ""); soon(); };
  el.done = () => { finished = true; if (timer) clearTimeout(timer); draw(); el.classList.remove("cv-live"); };
  el.text = () => text;
  draw();
  return el;
}

/**
 * Thinking, folded to its length ("Thinking · 8 s"): the label opens it. .set(text, label) redraws
 * both in place, so a thought that grows or learns its length keeps whether it is open.
 * @returns {HTMLElement & { set: (text: string, label?: string) => void }}
 */
export function thinkingRow(text, ts, label = "Thinking") {
  const body = h("div", { class: "cv-think-body", hidden: true }, String(text ?? ""));
  const word = h("span", { class: "cv-think-len" }, label);
  const btn = h("button", { class: "cv-think-head", type: "button", "aria-expanded": "false", onclick: () => {
    body.hidden = !body.hidden; btn.setAttribute("aria-expanded", String(!body.hidden));
  } }, icon("chevron", 12), word);
  const el = /** @type {any} */ (tag(h("div", { class: "cv-row cv-think" }, btn, body), "assistant", ts));
  let had = String(text ?? ""), said = label;
  el.set = (t, l) => {
    const s = String(t ?? "");
    if (s !== had) { had = s; body.replaceChildren(s); }
    if (l && l !== said) { said = l; word.replaceChildren(l); }
  };
  return el;
}

/**
 * The quiet line under a turn: time taken, tokens, cost ("18 s · 4.2k tokens · $0.04"). A stopped
 * turn leads with "Stopped by you" (t.byMe) or "Stopped"; a failed one with what failed. An open
 * turn (still running) draws nothing until it ends.
 */
export function turnRow(t) {
  const lead = t.canceled ? (t.byMe ? "Stopped by you" : "Stopped") : t.error ? "Turn failed: " + t.error : null;
  // A turn still going has no footer yet: its time and tokens so far read as if it had ended.
  const parts = t.open ? [] : [lead, ...turnParts(t)].filter(Boolean);
  const el = /** @type {any} */ (tag(h("div", { class: "cv-row cv-turn" + (t.open ? " cv-open" : "") + (t.error && !t.canceled ? " cv-turn-err" : "") }, parts.length ? parts.join(" · ") : null), "turn", t.ts));
  el._cost = typeof t.cost_usd === "number" ? t.cost_usd : null;
  return el;
}

// ---- tool cards ---------------------------------------------------------------

/** Output text, clipped past `max` lines with "show all". */
export function outputEl(text, { err = false, lang = "text", max = OUTPUT_LINES } = {}) {
  const c = clip(text, max);
  const pre = h("pre", { class: "cv-out" + (err ? " cv-err" : "") });
  const fill = s => { const code = h("code", { class: "lang-" + lang }); for (const t of highlight(s, lang)) add(code, t.cls ? h("span", { class: t.cls }, t.text) : t.text); put(pre, code); };
  fill(c.shown);
  if (!c.hidden) return pre;
  const more = h("button", { class: "cv-more", type: "button", onclick: () => { fill(String(text).replace(/\n+$/, "")); more.remove(); } }, `show all (${c.total} lines)`);
  return h("div", { class: "cv-out-wrap" }, pre, more);
}

const safeUrl = u => /^https?:\/\//i.test(String(u || ""));

/** Keys and values, for a tool (or an ask) this view has no special shape for. */
export function kvGrid(obj) {
  const rows = Object.entries(obj || {}).filter(([, v]) => v != null && v !== "");
  if (!rows.length) return null;
  return h("div", { class: "cv-kv" }, rows.map(([k, v]) => [
    h("span", { class: "cv-kv-k" }, k),
    h("span", { class: "cv-kv-v" }, typeof v === "string" ? v.slice(0, 2000) : JSON.stringify(v, null, 1).slice(0, 2000)),
  ]));
}

/** A todo list: completed struck through, the one in progress marked. */
export function checklist(todos) {
  return h("ul", { class: "cv-todos" }, (todos || []).map(t => h("li", { class: "cv-todo cv-todo-" + String(t && t.status || "pending") },
    h("span", { class: "cv-todo-box", "aria-hidden": "true" }, t && t.status === "completed" ? "✓" : ""),
    h("span", { class: "cv-todo-text" }, String((t && (t.status === "in_progress" && t.activeForm ? t.activeForm : t.content)) ?? "")),
  )));
}

/** The body of a tool card for its tool. */
function toolBody(b) {
  const i = b.input || {};
  const out = b.output;
  const err = !!b.error;
  const parts = [];
  switch (b.tool) {
    case "Bash":
      parts.push(h("pre", { class: "cv-cmd" }, h("code", null, "$ " + String(i.command ?? b.summary ?? ""))));
      if (i.description) parts.push(h("div", { class: "cv-note" }, String(i.description)));
      if (out != null && out !== "") parts.push(outputEl(out, { err, lang: "text", max: BASH_LINES }));
      break;
    case "Edit":
      // The path is the row's own summary; the detail starts at the diff.
      // The file's own line numbers when the result carried its patch; the strings alone otherwise.
      if (Array.isArray(b.patch) && b.patch.length) parts.push(renderRows(patchRows(b.patch)));
      else if (i.old_string != null || i.new_string != null) parts.push(renderUnified(i.old_string ?? "", i.new_string ?? ""));
      if (err && out) parts.push(outputEl(out, { err }));
      break;
    case "MultiEdit":
      if (Array.isArray(b.patch) && b.patch.length) { parts.push(renderRows(patchRows(b.patch))); if (err && out) parts.push(outputEl(out, { err })); break; }
      for (const e of Array.isArray(i.edits) ? i.edits : []) parts.push(renderUnified(e.old_string ?? "", e.new_string ?? ""));
      if (err && out) parts.push(outputEl(out, { err }));
      break;
    case "Write":
      parts.push(fileLine(i.file_path, "new file", b.cwd));
      if (i.content != null) parts.push(outputEl(i.content, { lang: langOf(i.file_path), max: 20 }));
      if (err && out) parts.push(outputEl(out, { err }));
      break;
    case "Read":
      if (out) parts.push(outputEl(out, { err, lang: err ? "text" : langOf(i.file_path) }));
      break;
    case "Grep": case "Glob": {
      const lines = out ? String(out).split("\n").filter(Boolean) : [];
      if (err) { parts.push(outputEl(out, { err })); break; }
      if (!lines.length && out != null) parts.push(h("div", { class: "cv-note" }, "No matches"));
      const list = h("ul", { class: "cv-hits" }, lines.slice(0, 20).map(l => h("li", null, l)));
      if (lines.length) parts.push(list);
      if (lines.length > 20) parts.push(h("button", { class: "cv-more", type: "button", onclick: e => {
        put(list, lines.map(l => h("li", null, l))); /** @type {any} */ (e.currentTarget).remove(); } }, `show all (${lines.length})`));
      break;
    }
    case "WebFetch": case "WebSearch": {
      const url = i.url;
      parts.push(h("div", { class: "cv-link" }, icon("search", 12),
        url && safeUrl(url) ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, String(url)) : h("span", null, String(url || i.query || b.summary || ""))));
      if (i.prompt) parts.push(h("div", { class: "cv-note" }, String(i.prompt)));
      if (out) parts.push(outputEl(out, { err, max: 8 }));
      break;
    }
    case "TodoWrite":
      parts.push(checklist(Array.isArray(i.todos) ? i.todos : []));
      break;
    default:
      if (Object.keys(i).length) parts.push(kvGrid(i));
      else if (b.summary) parts.push(h("div", { class: "cv-note" }, b.summary));
      if (b.destination) parts.push(h("div", { class: "cv-note" }, "to " + b.destination));
      if (out) parts.push(outputEl(out, { err }));
  }
  // A picture the tool's result carried (cohesion item 18: "an image the agent made"), whatever
  // the tool - a screenshot, a Canva render, a read of an image file. Same thumbnail and lightbox
  // as the person's own pasted pictures, just after the tool's own detail rather than the words.
  const pics = inlineable(b.images), big = tooLarge(b.images);
  if (pics.length) parts.push(h("div", { class: "cv-user-images" }, pics.map(p => pictureThumb(p, b.tool))));
  if (big.length) parts.push(h("div", { class: "cv-user-images" }, big.map(fileChip)));
  return parts;
}

/** The file a detail is about, relative to the session's folder (the whole path in its title). */
function fileLine(path, note, cwd = null) {
  return h("div", { class: "cv-file" }, icon("file", 12), h("span", { class: "cv-file-path", title: String(path || "") }, shortPath(path, cwd)),
    note ? h("span", { class: "cv-file-note" }, note) : null);
}

/** The row's icon from the stroke set (tool-row.md): file, terminal, search, globe (as search), agents, else the chevron alone. */
function toolIcon(tool) {
  const name = ({ Read: "file", Edit: "file", MultiEdit: "file", Write: "file", NotebookEdit: "file", Bash: "terminal", BashOutput: "terminal",
    KillShell: "terminal", KillBash: "terminal", Grep: "search", Glob: "search", WebFetch: "search", WebSearch: "search", Task: "agents", Agent: "agents",
    TodoWrite: "check", AskUserQuestion: "ask", ExitPlanMode: "lines" })[tool];
  return name ? icon(name, 14) : null;
}

/**
 * A teammate handoff (teammates.md section 3, tool-row.md's "Handoff" variant): a session calling
 * team_ask/team.ask. Distinct from toolCard - not colour, per avatar.md's "no per-teammate hue"
 * ruling - the teammate's own character (js/avatars.js, seeded from its teammate id, "<role>-<project>"
 * from `b.project`, the session's project), its role name, a plain
 * "Teammate" tag, verb "Asked" while no reply has landed yet (b.reply), "Replied" once it has.
 * Never folded into a run (core/grouping.js's BY_NAME/foldable), always its own line; "collapsed"
 * (the default) only ever means the reply detail is shut. The reply renders as turn prose
 * (markdown), never a code block - it is words, not a tool's output.
 * @param {any} b { tool: "team_ask"|"team.ask", input: { to, text, ... }, reply?: string, error?: boolean, project?: string }
 * @returns {HTMLElement & { update: (b: any) => void, tick: (now?: number) => void }}
 */
export function handoffCard(b) {
  const project = b.project || b.input?.project || null;
  const el = /** @type {any} */ (tag(h("div", { class: "cv-row cv-tool cv-handoff" }), "assistant", b.ts));
  let open = false;
  el.tick = () => {}; // no elapsed timer while waiting (tool-row.md: "a teammate's own pace is its business")
  el.update = nb => {
    b = nb;
    const role = String(b.input?.to || "");
    const ask = String(b.input?.text || b.summary || "");
    const replied = typeof b.reply === "string";
    const failed = !!b.error;
    const verb = failed ? "Asked" : replied ? "Replied" : "Asked";
    const inner = h("div", { class: "cv-tool-inner cv-handoff-reply msg-text" });
    const body = h("div", { class: "cv-tool-body", "aria-hidden": String(!open) }, inner);
    let built = false;
    const fill = () => { if (!built && replied) { built = true; add(inner, renderMarkdown(b.reply || "")); } };
    const show = () => {
      if (open) { fill(); el.setAttribute("data-open", ""); } else el.removeAttribute("data-open");
      body.setAttribute("aria-hidden", String(!open));
      head.setAttribute("aria-expanded", String(!!open));
    };
    el.setAttribute("data-state", failed ? "failed" : replied ? "done" : "running");
    const head = h("button", { class: "cv-tool-head cv-handoff-head", type: "button",
      disabled: !replied && !failed, "aria-label": `${verb} ${role}, Teammate, ${ask}`,
      onclick: () => { if (!replied && !failed) return; open = !open; show(); } },
      h("span", { class: "cv-chev", "aria-hidden": "true" }, icon("right", 12)),
      teammateAvatar(teammateId(role, project), { size: 24, cls: "av-agent", project }),
      h("span", { class: "cv-handoff-line" },
        h("span", { class: "cv-tool-name" }, verb + " "),
        h("span", { class: "cv-handoff-name" }, role),
        h("span", { class: "tag cv-handoff-tag" }, "Teammate"),
        ask ? h("span", { class: "cv-handoff-sum" }, " to " + ask) : null,
      ),
      failed ? h("span", { class: "cv-tool-state cv-failed" }, "no answer") : null,
    );
    // "@design" made this teammate a moment ago: say so, and offer Undo while nothing has run (no reply yet).
    const made = !replied && !failed && project ? madeNow(project, role) : null;
    const undo = made ? h("button", { class: "btn btn-ghost btn-sm cv-made-undo", type: "button", onclick: async () => {
      undo.disabled = true;
      let r = await attempt("team.retire", { project, role, undo: true });
      // Refused because it has already run: a plain retire instead (the teammate goes, its history stays), no second prompt.
      if (r.error && !r.error.missing) {
        const plain = await attempt("team.retire", { project, role });
        if (!plain.error) { unmark(project, role); put(madeLine, `Retired ${role}.`); return; }
        r = plain;
      }
      if (r.error) { undo.disabled = false; put(madeLine, `Made ${role}, a new teammate. Could not undo it: ${r.error.missing ? "this box cannot remove teammates yet" : r.error.message || r.error.code}`, undo); return; }
      unmark(project, role);
      put(madeLine, `Undone. ${role} is gone.`);
    } }, "Undo") : null;
    const madeLine = made ? h("div", { class: "cv-made", role: "status" }, `Made ${role}, a new teammate `, undo) : null;
    put(el, head, body, madeLine);
    show();
  };
  el.update(b);
  return el;
}

/**
 * A tool call as a card. `b` is a transcript tool block, or a live one built from thread.tool
 * ({ tool, summary, destination } with no input yet). The card's .update(b) redraws it in place,
 * keeping whether it is open.
 * @returns {HTMLElement & { update: (b: any) => void, tick: (now?: number) => void }}
 */
export function toolCard(b) {
  // A result that carries a render payload (a PR, a thread, an event, a diff, an artifact) is that card, not a generic tool row.
  const shown = toolDisplay(b);
  if (shown) return shown;
  const el = /** @type {any} */ (tag(h("div", { class: "cv-row cv-tool" }), "assistant", b.ts));
  let open = null;
  /** @type {any} */ let timeEl = null;
  el.tick = (now = Date.now()) => { if (timeEl && b.ts && toolState(b) === "running") timeEl.replaceChildren(elapsed(now - b.ts)); };
  el.update = nb => {
    b = nb;
    timeEl = null;
    const state = toolState(b);
    if (open === null && (state !== "running" || b.input)) open = opensByDefault({ ...b, error: state === "failed" });
    const title = b.input && Object.keys(b.input).length ? toolTitle(b.tool, b.input, b.cwd) : (b.summary || "");
    // Running but the session waits on the person (its ask is open): no clock, "waiting on you".
    const waiting = state === "running" && !!b.waiting;
    const shown = waiting ? "waiting" : state;
    // A call still running counts up ("0:42"), so quiet work never looks stalled; tick() moves it.
    // A todo list's time says nothing.
    const d = b.tool === "TodoWrite" || waiting ? "" : state === "running" && b.ts ? elapsed(Date.now() - b.ts) : duration(b.duration_ms);
    // A command that ended says its exit code when the provider gave one; a non-zero one reads as a failure.
    const exit = state === "done" && typeof b.exit === "number" && b.exit !== 0 ? b.exit : null;
    const word = shown === "failed" ? "failed" : shown === "canceled" ? "stopped" : shown === "waiting" ? "waiting on you" : exit !== null ? `exit ${exit}` : null;
    el.setAttribute("data-tool", String(b.tool || ""));
    el.setAttribute("data-state", shown);
    // The body is built the first time it opens, so a long session's closed cards cost nothing.
    // It stays in the DOM once built, and CSS expands and collapses it (grid rows, 180 ms).
    const inner = h("div", { class: "cv-tool-inner" });
    const body = h("div", { class: "cv-tool-body", "aria-hidden": String(!open) }, inner);
    let built = false;
    const fill = () => { if (!built) { built = true; add(inner, toolBody(b)); } };
    const show = () => {
      if (open) { fill(); el.setAttribute("data-open", ""); } else el.removeAttribute("data-open");
      body.setAttribute("aria-hidden", String(!open));
      head.setAttribute("aria-expanded", String(!!open));
    };
    const verb = toolVerb(b.tool, shown);
    const head = h("button", { class: "cv-tool-head", type: "button", "aria-label": [verb, title, word || (d && state !== "running" ? d : null)].filter(Boolean).join(", "),
      onclick: () => { open = !open; show(); } },
      h("span", { class: "cv-chev", "aria-hidden": "true" }, icon("right", 12)),
      h("span", { class: "cv-tool-icon", "aria-hidden": "true" }, state === "running" && !waiting ? h("span", { class: "cv-spin" }) : toolIcon(b.tool)),
      h("span", { class: "cv-tool-name" }, verb),
      h("span", { class: "cv-tool-title", title: title.length > 60 ? title : null }, title),
      h("span", { class: "cv-tool-meta" },
        d ? (timeEl = h("span", { class: "cv-tool-time" }, d)) : null,
        word ? h("span", { class: "cv-tool-state cv-" + (exit !== null ? "failed" : shown) }, word) : null),
    );
    put(el, head, body);
    show();
  };
  el.update(b);
  return el;
}


/** A block as its row. @param {any} b @param {{ who?: string, me?: string|null }} [ctx] */
export function blockRow(b, ctx = {}) {
  if (b.kind === "user") { const el = userRow(ctx.who || "you", b.command ? commandText(b.text) : b.text, b.ts, ctx.me, Array.isArray(b.images) ? b.images : Number(b.images) || 0); if (b.command) el.classList.add("cv-command"); return el; }
  if (b.kind === "text") return textRow(b.text, b.ts);
  if (b.kind === "thinking") return thinkingRow(b.text, b.ts);
  if (b.kind === "tool") return toolCard(b);
  if (b.kind === "turn") return turnRow(b);
  return tag(h("div", { class: "cv-row" }), "card", b.ts);
}

// ---- the raw view -------------------------------------------------------------

/** The blocks the way Claude Code's terminal prints them, in one mono block. */
export function rawView(blocks) {
  const pre = h("pre", { class: "cv-raw" });
  for (const line of rawLines(blocks)) {
    const m = /^(⏺ |> |✻ |  ⎿  )(.*)$/.exec(line);
    if (m) add(pre, [h("span", { class: m[1] === "⏺ " ? "cv-raw-dot" : m[1] === "> " ? "cv-raw-you" : m[1] === "✻ " ? "cv-raw-think" : "cv-raw-out" }, m[1]), m[2], "\n"]);
    else add(pre, [line, "\n"]);
  }
  return pre;
}
