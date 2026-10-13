// @ts-check
// The markdown editor's formatting, as text edits: each takes the text and the selection ({ start, end }) and answers the new text and where the selection goes. Pure, so the toolbar and the keys are tested
// without a screen.

/** @typedef {{ start: number, end: number }} Sel */
/** @typedef {"bold" | "italic" | "code" | "link" | "h1" | "h2" | "h3" | "bullet" | "number" | "task" | "quote" | "fence"} Format */

/** The whole lines a selection touches: [from, to) in the text. @param {string} text @param {Sel} sel */
function lineSpan(text, sel) {
  const from = text.lastIndexOf("\n", sel.start - 1) + 1;
  let to = text.indexOf("\n", sel.end);
  if (to < 0) to = text.length;
  return { from, to };
}

/** @param {string} text @param {Sel} sel @param {string} mark */
function wrap(text, sel, mark) {
  const inner = text.slice(sel.start, sel.end);
  const before = text.slice(sel.start - mark.length, sel.start), after = text.slice(sel.end, sel.end + mark.length);
  if (before === mark && after === mark) return { text: text.slice(0, sel.start - mark.length) + inner + text.slice(sel.end + mark.length), sel: { start: sel.start - mark.length, end: sel.end - mark.length } };
  if (inner.startsWith(mark) && inner.endsWith(mark) && inner.length >= mark.length * 2) return { text: text.slice(0, sel.start) + inner.slice(mark.length, -mark.length) + text.slice(sel.end), sel: { start: sel.start, end: sel.end - mark.length * 2 } };
  const body = inner || "text";
  const out = text.slice(0, sel.start) + mark + body + mark + text.slice(sel.end);
  return { text: out, sel: { start: sel.start + mark.length, end: sel.start + mark.length + body.length } };
}

/** @param {string} text @param {Sel} sel @param {(line: string, i: number) => string} f */
function perLine(text, sel, f) {
  const { from, to } = lineSpan(text, sel);
  const lines = text.slice(from, to).split("\n").map(f);
  const joined = lines.join("\n");
  return { text: text.slice(0, from) + joined + text.slice(to), sel: { start: from, end: from + joined.length } };
}

const LEAD = /^(\s*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> )?/;

/** @param {string} text @param {Sel} sel @param {Format} f @returns {{ text: string, sel: Sel }} */
export function applyFormat(text, sel, f) {
  switch (f) {
    case "bold": return wrap(text, sel, "**");
    case "italic": return wrap(text, sel, "_");
    case "code": return wrap(text, sel, "`");
    case "link": {
      const inner = text.slice(sel.start, sel.end) || "text";
      const out = text.slice(0, sel.start) + `[${inner}](https://)` + text.slice(sel.end);
      const at = sel.start + inner.length + 3;
      return { text: out, sel: { start: at, end: at + 8 } };
    }
    case "h1": case "h2": case "h3": {
      const mark = "#".repeat(Number(f[1])) + " ";
      return perLine(text, sel, l => { const m = LEAD.exec(l); const rest = l.slice(m ? m[0].length : 0); const had = m && m[2] && /^#/.test(m[2]) ? m[2] : ""; return had === mark ? rest : (m ? m[1] : "") + mark + rest; });
    }
    case "bullet": return perLine(text, sel, l => { const m = LEAD.exec(l) || [""]; return m[2] === "- " ? l.slice(m[0].length) : (m[1] || "") + "- " + l.slice(m[0].length); });
    case "number": return perLine(text, sel, (l, i) => { const m = LEAD.exec(l) || [""]; return /^\d/.test(m[2] || "") ? l.slice(m[0].length) : (m[1] || "") + `${i + 1}. ` + l.slice(m[0].length); });
    case "task": return perLine(text, sel, l => { const m = LEAD.exec(l) || [""]; return /\[[ xX]\] $/.test(m[2] || "") ? l.slice(m[0].length) : (m[1] || "") + "- [ ] " + l.slice(m[0].length); });
    case "quote": return perLine(text, sel, l => { const m = LEAD.exec(l) || [""]; return m[2] === "> " ? l.slice(m[0].length) : (m[1] || "") + "> " + l.slice(m[0].length); });
    case "fence": {
      const inner = text.slice(sel.start, sel.end);
      const pre = sel.start > 0 && text[sel.start - 1] !== "\n" ? "\n" : "";
      const out = text.slice(0, sel.start) + pre + "```\n" + inner + "\n```\n" + text.slice(sel.end);
      const at = sel.start + pre.length + 4;
      return { text: out, sel: { start: at, end: at + inner.length } };
    }
  }
}

/**
 * Enter in a list continues it: "- a" then Enter starts "- ", "- [ ] a" starts "- [ ] ", "3. a" starts "4. "; Enter on an empty item ends the list. Answers null when the line is not a list item.
 * @param {string} text @param {number} at where the caret is
 */
export function continueList(text, at) {
  const from = text.lastIndexOf("\n", at - 1) + 1;
  const line = text.slice(from, at);
  const m = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) )(.*)$/.exec(line);
  if (!m) return null;
  if (m[5] === "") return { text: text.slice(0, from) + text.slice(at), at: from };
  const mark = m[3] !== undefined ? `${Number(m[3]) + 1}${m[4]} ` : /\[/.test(m[2]) ? m[2].replace(/\[[xX]\]/, "[ ]") : m[2];
  const add = "\n" + m[1] + mark;
  return { text: text.slice(0, at) + add + text.slice(at), at: at + add.length };
}
