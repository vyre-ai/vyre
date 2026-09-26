// @ts-check
// The screen as rows of text, exactly `rows` of them, none wider than `columns`. Pure: the
// driver diffs these rows against the last frame and repaints only what changed.
//
//   title bar      vyre · the filter · counts
//   body           the list on the left, the selected item on the right (stacked when narrow)
//   status line    a message, or the keys that matter here · version · link
//
// Every piece is built as plain text, cut to its width, and only then coloured, so a colour code
// can never be cut in half or counted as a column.

import { dim, bold, signal, beacon, recall } from "../style.js";
import { fit, clip, width, wrap, sanitize } from "./width.js";
import { label } from "../../daemon/build.js";
import { highlight } from "./fuzzy.js";
import { view, selectable, current, KEYS, ago, since, threadLabel, liveHolder, SURFACE } from "./model.js";

const WIDE = 80;

/**
 * @param {import("./model.js").State} st
 * @param {{ columns?: number, rows?: number, transcripts?: Map<string, import("./transcript.js").Transcript>,
 *   details?: Map<string, any>, alive?: (pid: number) => boolean }} [o]
 * @returns {string[]}
 */
export function render(st, { columns = 80, rows = 24, transcripts = new Map(), details = new Map(), alive } = {}) {
  const C = Math.max(20, columns);
  const R = Math.max(6, rows);
  const body = R - 2;
  const out = [titleBar(st, C)];
  if (st.help) out.push(...help(C, body));
  else if (C >= WIDE) {
    const L = Math.max(28, Math.min(48, Math.round(C * 0.38)));
    const left = list(st, L, body);
    const right = pane(st, C - L - 3, body, transcripts, details, alive);
    for (let i = 0; i < body; i++) out.push(left[i] + dim(" │ ") + right[i]);
  } else {
    const top = Math.max(3, Math.ceil(body / 2));
    const bottom = body - top - 1;
    out.push(...list(st, C, top));
    const it = current(st);
    const name = "── " + (it ? clip(sanitize(it.label), C - 8) + " " : "");
    out.push(dim(name + "─".repeat(Math.max(0, C - width(name)))));
    if (bottom > 0) out.push(...pane(st, C, bottom, transcripts, details, alive));
  }
  out.push(statusLine(st, C));
  return out.slice(0, R);
}

function titleBar(st, C) {
  const d = st.data;
  const working = d.threads.filter(t => t.status === "working").length;
  const counts = [working ? `${working} working` : "", d.asks.length ? `${d.asks.length} ask${d.asks.length === 1 ? "" : "s"}` : "",
    d.drafts && d.drafts.length ? `${d.drafts.length} held` : ""].filter(Boolean).join(" · ");
  const left = st.filter ? `vyre  /${sanitize(st.filter)}` : "vyre";
  const hint = st.filter ? "" : "  type to filter · ? keys";
  const counted = clip(counts, Math.max(0, C - 6));
  const room = C - width(counted) - 1;
  const l = clip(left, room);
  const h = clip(hint, Math.max(0, room - width(l)));
  const pad = " ".repeat(Math.max(0, C - width(l) - width(h) - width(counted)));
  const title = st.filter ? bold(l.slice(0, 4)) + signal(l.slice(4)) : bold(l);
  return title + dim(h) + pad + (d.asks.length || (d.drafts && d.drafts.length) ? beacon(counted) : dim(counted));
}

/** The list, `h` rows of exactly `w` columns, scrolled so the cursor is in view. */
function list(st, w, h) {
  const v = view(st);
  const at = Math.max(0, v.findIndex(it => it.key === st.cursor));
  const rows = [];
  if (!v.length) rows.push(dim(fit("  nothing matches · esc clears the filter", w)));
  // Keep a little context above the cursor rather than pinning it to the last row.
  const start = Math.max(0, Math.min(at - Math.floor(h / 3), v.length - h));
  const shown = v.slice(start, start + h);
  for (const it of shown) rows.push(row(st, it, w));
  if (start > 0 && rows.length) rows[0] = dim(fit(`  ${start} more above`, w));
  if (start + h < v.length && rows.length === h) rows[h - 1] = dim(fit(`  ${v.length - start - h + 1} more below`, w));
  while (rows.length < h) rows.push(" ".repeat(w));
  return rows;
}

function row(st, it, w) {
  const indent = "  ".repeat(it.depth || 0);
  if (it.kind === "header") {
    const n = it.count ? ` (${it.count})` : "";
    const text = fit(` ${indent}${it.label}${n}`, w);
    return it.key === "h:inbox" && it.count ? beacon(bold(text)) : bold(text);
  }
  if (it.kind === "note") return dim(fit(`   ${indent}${it.label}`, w));
  const on = it.key === st.cursor;
  const mark = it.kind === "project" ? (it.open ? "▾ " : "▸ ") : it.kind === "ask" ? "? " : it.kind === "draft" ? "✉ " : it.kind === "thread" ? dot(it) : "  ";
  const lead = ` ${on ? "›" : " "} ${indent}`;
  const room = w - width(lead) - width(mark);
  const labelText = sanitize(it.label);
  // The label first, whole when it fits; the detail gets what is left, when that is worth showing.
  const label = clip(labelText, room);
  const restRoom = room - width(label) - 2;
  const detail = it.detail && restRoom > 5 ? "  " + clip(sanitize(it.detail), restRoom) : "";
  const pad = " ".repeat(Math.max(0, room - width(label) - width(detail)));
  const colourMark = it.kind === "ask" || it.kind === "draft" ? beacon(mark) : it.kind === "thread" && it.value && it.value.status === "working" ? signal(mark) : dim(mark);
  const shownLabel = highlight(label, (it.positions || []).filter(p => p < label.length - (label.endsWith("…") ? 1 : 0)), s => signal(s));
  return (on ? signal(lead) : lead) + colourMark + (on ? bold(shownLabel) : shownLabel) + dim(detail) + pad;
}

const dot = it => (it.value && it.value.status === "working" ? "● " : it.value && it.value.status === "waiting" ? "◆ " : "○ ");

/** The right pane: `h` rows of exactly `w` columns. */
function pane(st, w, h, transcripts, details, alive) {
  const it = current(st);
  /** @type {{ text: string, style?: string }[]} */
  let lines = [];
  let foot = null;
  if (!it) lines = [{ text: "nothing selected", style: "dim" }];
  else if (it.kind === "thread") {
    const t = it.value;
    const holder = liveHolder(t.holder, alive);
    lines.push({ text: threadLabel(t), style: "bold" });
    lines.push({ text: [String(t.id).slice(0, 8), t.status, holder === SURFACE ? "keyboard: this terminal" : holder ? "keyboard: " + holder : "keyboard free", t.agent || "", t.model || ""].filter(Boolean).join(" · "), style: "dim" });
    lines.push({ text: "", style: "dim" });
    const tr = transcripts.get(t.id);
    const body = [];
    if (!tr || !tr.ready) body.push({ text: "loading", style: "dim" });
    else if (!tr.lines.length) body.push({ text: "nothing said yet", style: "dim" });
    else for (const l of tr.lines) {
      // A wrapped line keeps its indent, so a quoted prompt reads as one block.
      const indent = /^ */.exec(l.text)[0].slice(0, Math.max(0, w - 10));
      for (const piece of wrap(l.text.slice(indent.length), w - indent.length)) body.push({ text: indent + piece, style: l.style });
    }
    const room = h - lines.length - 1;
    // Follow the end unless scrolled back; pgup in the compose line scrolls.
    const end = Math.max(0, body.length - st.scroll);
    const start = Math.max(0, end - room);
    lines.push(...body.slice(start, end));
    const typing = st.focus === "compose";
    const prompt = "› ";
    const text = typing ? tailFit(sanitize(st.compose), w - width(prompt) - 1) + "▏" : "tab to type · ctrl-l takes the keyboard";
    foot = typing ? signal(prompt) + text : dim(fit(prompt + text, w));
  } else lines = describe(it, st, details);
  const rows = lines.slice(0, foot ? h - 1 : h).map(l => colour(fit(l.text, w), l.style));
  while (rows.length < (foot ? h - 1 : h)) rows.push(" ".repeat(w));
  if (foot) rows.push(foot + " ".repeat(Math.max(0, w - width(foot))));
  return rows;
}

/** The end of a long compose line, so the cursor end is what shows. */
function tailFit(s, cols) {
  if (width(s) <= cols) return s;
  const chars = [...s];
  let out = "";
  for (let i = chars.length - 1; i >= 0 && width("…" + chars[i] + out) <= cols; i--) out = chars[i] + out;
  return "…" + out;
}

const colour = (s, style) => style === "dim" ? dim(s) : style === "beacon" ? beacon(s) : style === "bold" ? bold(s) : style === "sent" ? recall(s) : style === "signal" ? signal(s) : s;

/** What the right pane says about anything that is not a running thread. */
function describe(it, st, details) {
  const L = (text, style) => ({ text: sanitize(text), style });
  const para = (text, style) => String(text || "").split("\n").map(t => L(t, style));
  const v = it.value || {};
  switch (it.kind) {
    case "ask": return [
      L(it.label, "beacon"), L(""),
      ...(v.destination ? [L("to    " + v.destination)] : []),
      ...(v.reason ? [L("why   " + v.reason)] : []),
      L("from  " + it.detail.replace(/^ask · /, "")), L("asked " + since(v.at), "dim"), L(""),
      L(st.action ? "a allow · d deny · esc cancel" : "a allows · d denies · enter asks", "signal"),
      L("you confirm it is you before it counts", "dim"),
    ];
    case "draft": {
      const full = details.get(v.id);
      const content = full && (full.final || full.draft || full.content);
      const c = content && typeof content === "object" ? content : {};
      return [
        L(`${v.kind} via ${v.via}`, "beacon"), L(""),
        L("to    " + (Array.isArray(v.to) ? v.to.join(", ") : v.to || "")),
        ...(v.agent ? [L("from  " + v.agent)] : []), ...(v.why ? [L("why   " + v.why)] : []),
        L("held  " + since(v.at), "dim"), L(""),
        ...(c.subject ? [L("subject  " + c.subject, "bold")] : []),
        ...(c.body || c.text ? para(c.body || c.text) : v.summary ? [L(v.summary)] : []),
        L(""), L(st.action ? "a approve and send · r reject · esc cancel" : "a approves and sends · r rejects · enter asks", "signal"),
        L("you confirm it is you before anything is sent", "dim"),
      ];
    }
    case "project": {
      const p = st.data.projects.find(x => x.slug === v) || {};
      return [L(p.name || v, "bold"), L(p.home || "", "dim"), L(""), L(`${p.threads || 0} sessions${p.last ? " · last " + since(p.last) : ""}`),
        L(""), L(it.open ? "enter closes it" : "enter opens it: its sessions, and New session in it", "dim")];
    }
    case "session": return [L(v.label, "bold"), L(v.cwd || "", "dim"), L(""),
      L([v.last ? "last " + since(v.last) : "", v.how && v.how.length ? "in the project by " + v.how.join(" and ") : ""].filter(Boolean).join(" · ")),
      L(String(v.id || ""), "dim"), L(""), L("enter resumes it in Claude Code", "signal")];
    case "new-in": return [L(it.label, "bold"), L(it.detail || "", "dim"), L(""), L("enter starts Claude Code there, told about the project", "signal")];
    case "new": return [L(it.label, "bold"), L(process.cwd(), "dim"), L(""), L("enter starts Claude Code in this folder", "signal")];
    case "agent": {
      const a = (st.data.agents || []).find(x => x.name === v) || {};
      return [L(a.name || v, "bold"), L([a.kind, a.status].filter(Boolean).join(" · "), "dim"), L(""), ...(a.doing ? [L(a.doing)] : []),
        L(""), L("enter talks to it, a line at a time", "signal")];
    }
  }
  return [L(it.label)];
}

function statusLine(st, C) {
  const d = st.data;
  const right = [d.link || "", d.health && d.health.version ? "vyred " + label(d.health) : ""].filter(Boolean).join(" · ");
  const it = current(st);
  const hint = st.focus === "compose" ? "enter sends · esc back · ctrl-l keyboard · pgup scroll"
    : st.action === "ask" ? "a allow · d deny · esc cancel"
    : st.action === "draft" ? "a approve · r reject · esc cancel"
    : it && it.kind === "ask" ? "a allow · d deny · ↑↓ move · ? keys · q quit"
    : it && it.kind === "draft" ? "a approve · r reject · ↑↓ move · ? keys · q quit"
    : it && it.kind === "thread" ? "tab type · ↑↓ move · ? keys · q quit"
    : "↑↓ move · enter open · type to filter · ? keys · q quit";
  const room = C - width(right) - 2;
  const left = st.status ? beacon(fit(" " + sanitize(st.status), Math.max(0, room))) : dim(fit(" " + hint, Math.max(0, room)));
  return left + "  " + dim(right);
}

function help(C, h) {
  const rows = [];
  const w = Math.min(C - 4, 72);
  const pad = " ".repeat(Math.max(0, Math.floor((C - w) / 2)));
  rows.push("");
  rows.push(pad + bold(fit("Keys", w)));
  rows.push("");
  for (const [k, what] of KEYS) rows.push(pad + signal(fit(k, 12)) + fit(what, w - 12));
  rows.push("");
  rows.push(pad + dim(fit("any key closes this", w)));
  const out = rows.slice(0, h).map(r => r + " ".repeat(Math.max(0, C - width(r))));
  while (out.length < h) out.push(" ".repeat(C));
  return out;
}

export { selectable };
