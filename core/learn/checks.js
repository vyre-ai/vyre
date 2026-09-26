// @ts-check
// checks — what a lesson checks, as code (docs/SPEC.md section 7.11). Pure: no store, no daemon.
//
// A lesson's check is plain JSON, so the Deck and the CLI can show it and the user can edit it:
//
//   { kind: "text",    pattern, flags?, label }       nothing Claude writes matches the pattern:
//                                                     not its reply (at Stop), not the content of
//                                                     a Write or Edit (before the tool runs)
//   { kind: "touched", require, when?, label }        a turn that changed a file matching `when`
//                                                     (code, by default) also changed `require`
//   { kind: "before",  command, first, label }        a shell command matching `command` runs only
//                                                     after one matching `first`, since the last
//                                                     file change (tests before a commit)
//
// distill() turns what the user said into a lesson when a known shape fits. Anything else stays
// a lesson without a check, which Enrich repeats to Claude; a model may distill it later, off the
// hot path, but never here.

/** Files that count as code for a "touched" check, unless the lesson says otherwise. */
export const CODE = "\\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|css|scss|html|vue|svelte|sql)$";
const TESTS = "\\b(npm (run )?test|npm t\\b|node --test|pnpm (run )?test|yarn test|pytest|go test|cargo test|make test|bun test)";

/** Words that make a correction a rule the user means every time. Such lessons start at block. */
const FIRM = /\b(never|always|from now on|whenever|every time|each time|no more|i told you|under no circumstances)\b/i;
/** Weaker words: enough to fit a known check, not enough to propose a free-text rule on their own. */
const SOFT = /\b(don'?t|do not|stop|avoid|quit|no longer|remember to|make sure (to|you))\b/i;

/** Characters people ban by name, with the pattern that finds them. */
const CHARS = [
  { name: /\bem[- ]?dash(es)?\b|\u2014/i, pattern: "\u2014", label: "an em dash (\u2014)", rule: "Never use em dashes." },
  { name: /\ben[- ]?dash(es)?\b|\u2013/i, pattern: "\u2013", label: "an en dash (\u2013)", rule: "Never use en dashes." },
  { name: /\bemojis?\b/i, pattern: "\\p{Extended_Pictographic}", flags: "u", label: "an emoji", rule: "Never use emoji." },
  { name: /\bsemi-?colons?\b/i, pattern: ";", label: "a semicolon", rule: "Never use semicolons in prose." },
];

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sentence = s => { const t = s.replace(/\s+/g, " ").trim().slice(0, 240); const u = t.charAt(0).toUpperCase() + t.slice(1); return /[.!?]$/.test(u) ? u : u + "."; };

/**
 * A lesson from something the user said, or null when it is not a correction at all.
 * @param {string} said
 * @returns {{ rule: string, when: string, check: any, level: "remind"|"ask"|"block" } | null}
 */
export function distill(said) {
  const text = String(said || "").trim();
  if (!text || text.startsWith("/")) return null;
  const firm = FIRM.test(text), soft = SOFT.test(text);
  if (!firm && !soft) return null;
  const level = firm ? "block" : "remind";

  // "update CHANGELOG.md whenever you change code"
  const req = text.match(/\b(?:update|touch|edit|add (?:an entry )?to|write (?:to|in))\s+(?:the\s+)?([\w./-]+\.(?:md|txt|rst)|changelog)\b[^.]*?\b(?:whenever|when(?:ever)?|every time|each time|if|after)\s+(?:you\s+)?(?:change|edit|touch|modify|write)\s+(?:any\s+)?(code|files?)/i);
  if (req) {
    const file = /^changelog$/i.test(req[1]) ? "CHANGELOG.md" : req[1];
    const code = !/^files?$/i.test(req[2]);
    return { rule: `Update ${file} whenever you change ${code ? "code" : "a file"}.`, when: "always", level,
      check: { kind: "touched", require: file, when: code ? CODE : ".", label: `${file} changed when ${code ? "code" : "anything"} did` } };
  }

  // "run the tests before you commit"
  const before = text.match(/\b(?:run|use)\s+(?:the\s+)?tests?\s+before\s+(?:you\s+|each\s+|every\s+|any\s+)?(commit|push)/i);
  if (before) {
    const what = before[1].toLowerCase();
    return { rule: `Run the tests before every git ${what}.`, when: "always", level,
      check: { kind: "before", command: `\\bgit\\s+${what}\\b`, first: TESTS, label: `tests ran before git ${what}` } };
  }

  // "never use em dashes"
  if (/\b(never|don'?t|do not|stop|avoid|no more|quit)\b/i.test(text)) {
    for (const c of CHARS) if (c.name.test(text)) {
      return { rule: c.rule, when: "always", level, check: { kind: "text", pattern: c.pattern, ...(c.flags ? { flags: c.flags } : {}), label: c.label } };
    }
    // never say "circle back"
    const q = text.match(/\b(?:never|don'?t|do not|stop|avoid)\s+(?:ever\s+)?(?:use|say|write|type|put)\s+(?:the\s+(?:word|phrase)\s+)?["\u201c']([^"\u201d']{1,60})["\u201d']/i);
    if (q) return { rule: `Never write "${q[1]}".`, when: "always", level, check: { kind: "text", pattern: escape(q[1]), flags: "i", label: `"${q[1]}"` } };
  }

  // A rule with no check: only when the user plainly meant it as one.
  return firm ? { rule: sentence(text), when: "always", level: "remind", check: null } : null;
}

/** Is a check well formed? Returns a problem, or null. */
export function invalid(check) {
  if (check == null) return null;
  if (typeof check !== "object" || Array.isArray(check)) return "check must be an object";
  const re = (s, f) => { try { new RegExp(String(s), f); return null; } catch (e) { return /** @type {Error} */ (e).message; } };
  if (check.kind === "text") return typeof check.pattern === "string" && check.pattern ? re(check.pattern, check.flags || "") : "a text check needs a pattern";
  if (check.kind === "touched") return typeof check.require === "string" && check.require ? re(check.when || CODE, "i") : "a touched check needs require";
  if (check.kind === "before") return typeof check.command === "string" && typeof check.first === "string" ? re(check.command, "i") || re(check.first, "i") : "a before check needs command and first";
  return `unknown check kind ${check.kind}`;
}

/** The regex of a text check, global so it can count. */
const textRe = c => new RegExp(c.pattern, [...new Set(((c.flags || "") + "g").split(""))].join(""));

/** A short piece of text around the first match, so Claude can find it. */
function around(text, re) {
  re.lastIndex = 0;
  const m = re.exec(text);
  if (!m) return "";
  const a = Math.max(0, m.index - 30), b = Math.min(text.length, m.index + m[0].length + 30);
  return (a ? "\u2026" : "") + text.slice(a, b).replace(/\s+/g, " ") + (b < text.length ? "\u2026" : "");
}

/** What a writing tool is about to put in a file, or null for any other tool. */
export function written(tool, input) {
  if (!input || typeof input !== "object") return null;
  if (tool === "Write") return typeof input.content === "string" ? input.content : null;
  if (tool === "Edit") return typeof input.new_string === "string" ? input.new_string : null;
  if (tool === "MultiEdit") return Array.isArray(input.edits) ? input.edits.map(e => (e && typeof e.new_string === "string" ? e.new_string : "")).join("\n") : null;
  if (tool === "NotebookEdit") return typeof input.new_source === "string" ? input.new_source : null;
  return null;
}

/**
 * A lesson's check at Stop. `text` is the turn's final reply (null when Claude Code did not say);
 * `touched` the files changed this turn. Returns null when it passes or does not apply, or what
 * is wrong, in words Claude can act on.
 * @param {any} check
 * @param {{ text: string|null, touched: string[] }} turn
 * @returns {{ applied: boolean, problem: string|null }}
 */
export function atStop(check, { text, touched }) {
  if (!check) return { applied: false, problem: null };
  if (check.kind === "text") {
    if (text == null) return { applied: false, problem: null };
    const re = textRe(check);
    const n = (text.match(re) || []).length;
    return { applied: true, problem: n ? `Your reply has ${n === 1 ? check.label : `${n} of ${check.label.replace(/^an? /, "")}`}, at "${around(text, re)}". Write the reply again without ${n === 1 ? "it" : "them"}.` : null };
  }
  if (check.kind === "touched") {
    const when = new RegExp(check.when || CODE, "i");
    const want = String(check.require).toLowerCase();
    const is = f => { const l = f.toLowerCase(); return l === want || l.endsWith("/" + want); };
    const changed = touched.filter(f => !is(f) && when.test(f));
    if (!changed.length) return { applied: false, problem: null };
    if (touched.some(is)) return { applied: true, problem: null };
    const names = changed.slice(0, 3).map(f => f.split("/").slice(-2).join("/")).join(", ");
    return { applied: true, problem: `This turn changed ${names}${changed.length > 3 ? ` and ${changed.length - 3} more` : ""} but not ${check.require}. Update ${check.require}, then finish.` };
  }
  return { applied: false, problem: null };
}

/**
 * A lesson's check before a tool runs. `ran` is the shell commands seen since the last file
 * change in this thread. Returns null when it passes or does not apply.
 * @param {any} check
 * @param {{ tool: string, input: any, ran: string[] }} call
 * @returns {{ applied: boolean, problem: string|null }}
 */
export function atTool(check, { tool, input, ran }) {
  if (!check) return { applied: false, problem: null };
  if (check.kind === "text") {
    const body = written(tool, input);
    if (body == null) return { applied: false, problem: null };
    const re = textRe(check);
    return { applied: true, problem: re.test(body) ? `What this writes has ${check.label}, at "${around(body, re)}". Write it without.` : null };
  }
  if (check.kind === "before" && tool === "Bash" && typeof input?.command === "string" && new RegExp(check.command, "i").test(input.command)) {
    const first = new RegExp(check.first, "i");
    return { applied: true, problem: ran.some(c => first.test(c)) ? null : `Nothing has run that matches ${check.first} since the last change. Run it first.` };
  }
  return { applied: false, problem: null };
}

/**
 * Calls that would weaken what Vyre learned: retiring or editing a lesson from inside a turn,
 * reaching the store or the daemon's socket directly, or stopping the daemon. Claude may still
 * do these, but only after the user says yes. A lesson a model can quietly switch off is advice.
 * @returns {string|null} the reason to ask, or null
 */
export function weakens(tool, input) {
  if (/(^|__)learn_(retire|edit)$/.test(tool)) return "Retiring or changing a lesson is the user's call, not Claude's.";
  if (tool !== "Bash" || typeof input?.command !== "string") return null;
  const c = input.command;
  if (/\bvyre\s+learn\s+(retire|edit)\b/.test(c)) return "Retiring or changing a lesson is the user's call, not Claude's.";
  if (/vyre\.db\b|vyred\.sock\b|\/v1\/tools\/learn\./.test(c)) return "This reaches Vyre's store or socket directly, around the lessons the user taught.";
  if (/\bvyre\s+down\b|\b(pkill|killall)\b[^|;&]*\bvyred?\b/.test(c)) return "Stopping vyred would stop the lessons the user taught from being checked.";
  return null;
}
