// @ts-check
// A plan to approve (Claude Code's ExitPlanMode ask, input { plan: "<markdown>" }), read into the
// parts the plan card shows (docs/design/system/components/plan-card.md): a title, the numbered
// steps, what it will not touch, the files it expects to change, and the rest of the text.
//
// Only what the plan says: the title is its first heading (else its first line that is not a list
// item), the steps are its first numbered list (else its first bullet list), and "will not touch"
// and the files come only from a section of the plan that names them. Nothing is made up; a part
// the plan does not have is null (title, notTouch) or empty (steps, files).
//
// Shared core: no DOM and no Node APIs, so the Deck, the PWA and the Expo app read a plan the same way.

/**
 * @typedef {{ path: string, added: number|null, removed: number|null, isNew: boolean }} PlanFile
 * @typedef {{ title: string|null, steps: string[], notTouch: string|null, files: PlanFile[], rest: string }} Plan
 */

/** The two modes a plan can continue in, in the card's order (mode-chip.md's plain names). */
export const PLAN_MODES = Object.freeze([
  Object.freeze({ mode: "default", label: "Asks first" }),
  Object.freeze({ mode: "acceptEdits", label: "Edits allowed" }),
]);
/** @param {string} mode */
export const planModeLabel = mode => (PLAN_MODES.find(m => m.mode === mode) || PLAN_MODES[0]).label;

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NOT_TOUCH = /^(?:(?:what|things) (?:i|it) )?(?:will not touch|won'?t touch|not touching|do not touch|don'?t touch|will leave alone|leave alone|out of scope|not in scope)\b/i;
const FILES = /^(?:the )?(?:(?:files?(?: (?:it|i|we) (?:expects?|will|'ll|plan|expect) to (?:change|touch|edit)| (?:it|i|we) (?:will|'ll) (?:change|touch|edit)| to (?:change|edit|touch)| changed| touched| expected)?)|(?:expected|changed|critical) files)$/i;

/** A line's words with the markdown emphasis around a label taken off: "**Will not touch:**" reads "Will not touch:". */
const plainLabel = s => String(s).replace(/\*\*/g, "").trim();

/**
 * What kind of section a line opens, if any: a heading, or a label line ("Will not touch: ...",
 * "**Files:**"). `inline` is what follows the label's colon on the same line.
 * @param {string} line
 * @returns {{ kind: "notTouch"|"files"|"other", inline: string, heading: boolean }|null}
 */
function sectionOf(line) {
  const hd = HEADING.exec(line);
  if (hd) {
    const t = plainLabel(hd[2]).replace(/:$/, "").trim();
    return { kind: NOT_TOUCH.test(t) ? "notTouch" : FILES.test(t) ? "files" : "other", inline: "", heading: true };
  }
  if (BULLET.test(line) || ORDERED.test(line)) return null; // a list item is content, not a label
  const bold = /^\*\*/.test(line.trim());
  const plain = plainLabel(line.trim());
  const colon = /^([^:]{1,60}):\s*(.*)$/.exec(plain);
  const label = colon ? colon[1].trim() : plain;
  if (!colon && !bold) return null; // a bare sentence is not a label
  if (NOT_TOUCH.test(label)) return { kind: "notTouch", inline: colon ? colon[2].trim() : "", heading: false };
  if (FILES.test(label)) return { kind: "files", inline: colon ? colon[2].trim() : "", heading: false };
  return null;
}

/**
 * One file row from a list item: the path (the first code span, else the first word), and the
 * counts and "new" only when the line says them.
 * @param {string} item
 * @returns {PlanFile|null}
 */
export function fileOf(item) {
  const s = String(item).trim();
  const code = /`([^`]+)`/.exec(s);
  const path = code ? code[1].trim() : (s.split(/\s+/)[0] || "").replace(/[,;:]+$/, "");
  if (!path) return null;
  const after = code ? s.slice(0, code.index) + " " + s.slice(code.index + code[0].length) : s.slice(s.indexOf(path) + path.length);
  const add = /(?:^|[\s(,])\+(\d+)\b/.exec(after);
  const del = /(?:^|[\s(,])[−-](\d+)\b/.exec(after);
  return { path, added: add ? Number(add[1]) : null, removed: del ? Number(del[1]) : null, isNew: /\bnew\b/i.test(after) };
}

/**
 * Read a plan's markdown.
 * @param {unknown} markdown the plan (ExitPlanMode's input.plan)
 * @returns {Plan}
 */
export function parsePlan(markdown) {
  const text = typeof markdown === "string" ? markdown.replace(/\r\n?/g, "\n") : "";
  const lines = text.split("\n");
  const used = new Set();
  /** @type {Plan} */
  const plan = { title: null, steps: [], notTouch: null, files: [], rest: "" };

  // Title: the first heading, else the first line that is not a list item or a section label.
  const hIdx = lines.findIndex(l => HEADING.test(l) && sectionOf(l)?.kind === "other");
  if (hIdx >= 0) { plan.title = plainLabel(/** @type {RegExpExecArray} */ (HEADING.exec(lines[hIdx]))[2]) || null; used.add(hIdx); }
  else {
    const fIdx = lines.findIndex(l => l.trim() && !ORDERED.test(l) && !BULLET.test(l) && !sectionOf(l));
    if (fIdx >= 0) { plan.title = plainLabel(lines[fIdx].trim()) || null; used.add(fIdx); }
  }

  // Sections the plan names: "will not touch" and the files. A section runs to the next heading,
  // the next label, or (for a label) a blank line after its content.
  /** @type {Set<number>} lines inside a named section, kept out of the steps */
  const inSection = new Set();
  for (let i = 0; i < lines.length; i++) {
    const sec = sectionOf(lines[i]);
    if (!sec || sec.kind === "other") continue;
    used.add(i); inSection.add(i);
    /** @type {string[]} */ const body = [];
    /** @type {string[]} */ const items = [];
    if (sec.inline) body.push(sec.inline);
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (HEADING.test(l) || sectionOf(l)) break;
      if (!l.trim()) {
        // A label's section ends at the first blank line after its content; a heading's runs on.
        if (!sec.heading && (body.length || items.length)) break;
        used.add(j); inSection.add(j); continue;
      }
      const it = BULLET.exec(l) || ORDERED.exec(l);
      if (it) items.push((it[3] ?? it[2]).trim());
      else if (items.length && /^\s+\S/.test(l)) items[items.length - 1] += " " + l.trim();
      else if (!items.length) body.push(l.trim());
      else break;
      used.add(j); inSection.add(j);
    }
    if (sec.kind === "notTouch" && plan.notTouch == null) {
      const said = [body.join(" "), items.join(", ")].filter(Boolean).join(" ").trim();
      if (said) plan.notTouch = said;
    }
    if (sec.kind === "files" && !plan.files.length) {
      const rows = items.length ? items : body.flatMap(b => b.split(/,\s*/));
      plan.files = /** @type {PlanFile[]} */ (rows.map(fileOf).filter(Boolean));
    }
    i = j - 1;
  }

  // Steps: the first numbered list outside those sections, else the first bullet list. A list is
  // its top-level items; a line indented under an item joins it, a nested list stays with its item.
  const list = (/** @type {RegExp} */ re) => {
    const start = lines.findIndex((l, i) => !inSection.has(i) && !used.has(i) && re.test(l));
    if (start < 0) return null;
    const indent = /** @type {RegExpExecArray} */ (re.exec(lines[start]))[1].length;
    /** @type {string[]} */ const steps = [];
    /** @type {number[]} */ const taken = [];
    for (let i = start; i < lines.length; i++) {
      if (inSection.has(i)) break;
      const l = lines[i];
      const m = re.exec(l);
      if (m && m[1].length === indent) { steps.push((m[3] ?? m[2]).trim()); taken.push(i); continue; }
      if (!l.trim()) {
        const next = lines.slice(i + 1).find(x => x.trim());
        const nm = next ? re.exec(next) : null;
        if (nm && nm[1].length === indent) { taken.push(i); continue; }
        break;
      }
      if (/^\s+\S/.test(l) && steps.length) {
        if (!BULLET.test(l) && !ORDERED.test(l)) steps[steps.length - 1] += " " + l.trim();
        taken.push(i); continue;
      }
      break;
    }
    return { steps, taken };
  };
  const found = list(ORDERED) || list(BULLET);
  if (found) { plan.steps = found.steps.filter(Boolean); for (const i of found.taken) used.add(i); }

  // The rest: every line not read into a part above, as markdown, blank runs squeezed.
  plan.rest = lines.filter((_, i) => !used.has(i)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return plan;
}

/**
 * The files row's summary, only from what the plan said: "4 files", and "+140 −62" when every file
 * has its counts. @param {PlanFile[]} files
 * @returns {{ count: string, totals: string|null }}
 */
export function filesSummary(files) {
  const n = files.length;
  const count = `${n} ${n === 1 ? "file" : "files"}`;
  const all = n > 0 && files.every(f => f.added != null || f.removed != null);
  if (!all) return { count, totals: null };
  const add = files.reduce((s, f) => s + (f.added || 0), 0), del = files.reduce((s, f) => s + (f.removed || 0), 0);
  return { count, totals: `+${add} −${del}` };
}

/**
 * A file row's counts in words: "new · +60", "+18 −12", or "" when the plan gave none.
 * @param {PlanFile} f
 */
export function fileCounts(f) {
  const parts = [];
  if (f.added != null) parts.push(`+${f.added}`);
  if (f.removed != null) parts.push(`−${f.removed}`);
  const counts = parts.join(" ");
  return f.isNew ? (counts ? `new · ${counts}` : "new") : counts;
}

/**
 * The markdown inside one step or line, as pieces a surface draws: plain text, inline code and
 * bold. Nothing else is read (links and the like stay as their text).
 * @param {string} s
 * @returns {{ kind: "text"|"code"|"strong", text: string }[]}
 */
export function inlinePieces(s) {
  /** @type {{ kind: "text"|"code"|"strong", text: string }[]} */
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let at = 0, m;
  const str = String(s ?? "");
  while ((m = re.exec(str))) {
    if (m.index > at) out.push({ kind: "text", text: str.slice(at, m.index) });
    out.push(m[1] != null ? { kind: "code", text: m[1] } : { kind: "strong", text: m[2] });
    at = m.index + m[0].length;
  }
  if (at < str.length) out.push({ kind: "text", text: str.slice(at) });
  return out;
}

/** The plan's markdown from an ask, wherever the box put it (detail.input.plan, detail.plan, input.plan, plan). @param {any} ask */
export function planText(ask) {
  const d = ask && ask.detail;
  const v = d?.input?.plan ?? d?.plan ?? ask?.input?.plan ?? ask?.plan;
  return typeof v === "string" ? v : "";
}

/** Whether an ask is a plan to approve: kind "plan", or Claude Code's ExitPlanMode permission. @param {any} ask */
export const isPlanAsk = ask => !!ask && (ask.kind === "plan" || ask.tool === "ExitPlanMode");
