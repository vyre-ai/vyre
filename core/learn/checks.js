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

import os from "node:os";
import path from "node:path";

/** How many times one turn is sent back before it is allowed to end with the lesson broken. */
export const MAX_BLOCKS = 2;

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

/**
 * Lessons a draft's edit suggests: a banned-by-name character the user took out of every place
 * it appeared. Only characters, which an edit shows unambiguously; a changed word is a matter of
 * that one message, not a rule. Inferred rather than said, so each starts at remind.
 * @param {string} draft what Claude wrote
 * @param {string} final what the user sent
 */
export function fromEdit(draft, final) {
  const out = [];
  for (const c of CHARS) {
    const re = new RegExp(c.pattern, "g" + (c.flags || ""));
    if ((String(draft).match(re) || []).length && !(String(final).match(re) || []).length) {
      out.push({ rule: c.rule, when: "always", level: "remind", check: { kind: "text", pattern: c.pattern, ...(c.flags ? { flags: c.flags } : {}), label: c.label } });
    }
  }
  return out;
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

// Guards: calls that would weaken what Vyre learned. Anything that makes Vyre stricter is free;
// anything that makes it looser needs a person (ADR 0007, decision 11). These are asked, never
// denied: the user may mean it. A lesson a model can quietly switch off is advice.

const USER = "Retiring, relaxing or accepting a lesson is the user's call, not Claude's.";
const STORE = "This reaches what Vyre learned (its store, socket or lesson files) directly, around the lessons the user taught.";
const DIRECT = "This calls Learning or the Harness directly, around the hooks that check the lessons the user taught.";
const HOOKS = "This changes the Vyre Harness's hooks, which check the lessons the user taught.";
const SETTINGS = "This changes Claude Code's settings, which could drop Vyre's plugin or its hooks.";
const STOP = "Stopping vyred would stop the lessons the user taught from being checked.";

/** What in the Vyre home holds or runs the lessons. A write to any of these is asked. */
const GUARDED = ["lessons.json", "learn-offline", "vyre.db", "vyre.db-wal", "vyre.db-shm", "vyred.sock", "vyred.pid", "learned"];
/** Names unusual enough to mean Vyre's files wherever they appear in a command. */
const NAMED = /vyre\.db\b|vyred\.(sock|pid)\b|\blearn-offline\b/;
/** Commands that only read. A command made only of these, with no redirect into a file, writes nothing. */
const READERS = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ls", "stat", "wc", "file", "diff", "jq", "du", "echo", "printf", "cd", "pwd", "test", "true", "sed", "find", "sort", "uniq", "cut", "tr", "column", "shasum", "sha256sum", "md5", "realpath", "readlink", "basename", "dirname"]);

const WRITES = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const untilde = p => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/** Does a shell command only read? Conservative: anything unknown writes. */
function readOnly(c) {
  const quiet = c.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, "");
  if (/>|\btee\b/.test(quiet)) return false;
  return quiet.split(/\|\|?|&&|;|\n/).every(seg => {
    const words = seg.trim().split(/\s+/).filter(w => !/^\w+=/.test(w));
    const cmd = (words[0] || "").split("/").pop() || "";
    if (!cmd) return true;
    if (!READERS.has(cmd)) return false;
    if (cmd === "sed" && words.some(w => /^-[a-zA-Z]*i|^--in-place/.test(w))) return false;
    if (cmd === "find" && words.some(w => /^-(delete|exec|execdir|ok|okdir|fprint)/.test(w))) return false;
    return true;
  });
}

/** How a command may spell the Vyre home: the path, ~, $HOME, ${HOME}, and $VYRE_HOME. */
function spellings(home) {
  const out = [home, "$VYRE_HOME", "${VYRE_HOME}"];
  const h = os.homedir();
  if (home.startsWith(h + path.sep)) { const rest = home.slice(h.length); out.push("~" + rest, "$HOME" + rest, "${HOME}" + rest); }
  return out;
}

/** Why a file in the home, the Harness's hooks or Claude Code's settings is guarded, or null. */
function guardedPath(abs, home) {
  if (abs === home || abs.startsWith(home + path.sep)) {
    const first = abs === home ? "" : abs.slice(home.length + 1).split(path.sep)[0];
    if (GUARDED.includes(first)) return STORE;
  }
  if (/(^|\/)harness\/hooks\/[^/]+$/.test(abs) || /\/\.claude\/plugins\/.*\/hooks\/(hook\.js|hooks\.json)$/.test(abs)) return HOOKS;
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(abs)) return SETTINGS;
  return null;
}

/** A shell glob as a regex over a whole path. */
const globRe = g => new RegExp("^" + g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

/**
 * Calls that would weaken what Vyre learned: retiring, relaxing or accepting a lesson from inside
 * a turn; calling Learning or the Harness directly; writing the lessons' files, the store, the
 * socket, the Harness's hooks or Claude Code's settings; stopping vyred. Asked at every level, by
 * learn.check online and by the hook offline.
 * @param {string} tool @param {any} input
 * @param {{ home?: string, cwd?: string }} [where] the Vyre home (default: config's) and the thread's folder
 * @returns {string|null} the reason to ask, or null
 */
export function weakens(tool, input, { home: root, cwd } = {}) {
  if (/(^|__)learn_(retire|relax|accept)$/.test(tool)) return USER;
  const home = path.resolve(root || process.env.VYRE_HOME || path.join(os.homedir(), ".vyre"));
  const key = WRITES[/** @type {keyof typeof WRITES} */ (tool)];
  if (key && typeof input?.[key] === "string") return guardedPath(path.resolve(cwd || home, untilde(input[key])), home);
  if (tool !== "Bash" || typeof input?.command !== "string") return null;
  // Quotes and backslashes split words without changing them: vy"re" is vyre.
  const c = input.command.replace(/\\\n/g, " ").replace(/["'`\\]/g, "");
  if (/\bvyre(\.js)?\s+learn\s+(retire|relax|edit|level|accept)\b/.test(c)) return USER;
  if (/\bvyre(\.js)?\s+call\s+(learn|harness)\./.test(c) || /\/v1\/tools\/(learn|harness)\./.test(c)) return DIRECT;
  if (/\bvyre(\.js)?\s+(down|stop|restart)\b/.test(c) || /\b(pkill|killall)\b[^|;&]*\bvyred?\b/.test(c)
    || /\blaunchctl\b[^|;&]*\b(unload|bootout|stop|kill|remove|disable)\b[^|;&]*vyre/i.test(c)
    || /\bsystemctl\b[^|;&]*\b(stop|kill|disable|mask)\b[^|;&]*vyre/.test(c)
    || (/\bkill\b/.test(c) && /vyred\.pid|\bpgrep\b[^|;&]*vyre/.test(c))) return STOP;
  const spelled = spellings(home);
  if (/--unix-socket|\bnc\b[^|;&]*\s-U\b|\bsocat\b[^|;&]*UNIX/i.test(c) && (/vyre|\$/.test(c) || spelled.some(s => c.includes(s)))) return STORE;
  if (readOnly(c)) return null;
  if (NAMED.test(c)) return STORE;
  if (/(^|[\s/=])harness\/hooks\/|\.claude\/plugins\/\S*\/hooks\/hooks?\.js(on)?/.test(c)) return HOOKS;
  if (/(^|[\s/=])\.claude\/settings(\.local)?\.json/.test(c)) return SETTINGS;
  // The home itself, or a guarded name in it. Its watchers/ and modules/ stay free.
  for (const s of spelled) for (let i = c.indexOf(s); i >= 0; i = c.indexOf(s, i + 1)) {
    const after = c.slice(i + s.length);
    if (/^[\w.-]/.test(after)) continue;                       // a longer name that starts the same
    const seg = /^\/([^\s/;|&)]*)/.exec(after);
    if (!seg || !seg[1] || GUARDED.includes(seg[1]) || /[*?[]/.test(seg[1])) return STORE;
  }
  // Globs that could match the home or a guarded file in it: ~/.vy*/lessons.json.
  for (const tok of c.split(/[\s;|&()<>=]+/)) {
    if (!/[*?[]/.test(tok)) continue;
    const re = globRe(tok.replace(/\/+$/, ""));
    if (spelled.some(s => re.test(s) || GUARDED.some(g => re.test(`${s}/${g}`)))) return STORE;
  }
  return null;
}

/**
 * A reply to a proposal: a plain yes or a plain no, and the lesson it names if it names one.
 * Anything with more in it is neither, so a sentence that happens to start with "no" leaves the
 * proposal waiting.
 * @param {string} said
 * @returns {{ yes: boolean, id: number|null } | null}
 */
export function reply(said) {
  const t = String(said || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[.,!]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 60) return null;
  const which = "(?:it|that|this|them|(?:lesson\\s+)?#?(\\d+))";
  const yes = new RegExp(`^(?:(?:yes|y|yep|yeah|yup|sure|ok|okay|please do|do it|go ahead|keep it)(?: please)?(?: (?:keep|accept) ${which})?(?: please)?|(?:keep|accept) ${which}(?: please)?)$`).exec(t);
  if (yes) return { yes: true, id: Number(yes[1] || yes[2]) || null };
  const no = new RegExp(`^(?:(?:no|n|nope|nah|don't|do not|no thanks|no thank you|not now)(?: (?:drop|discard|skip) ${which})?|(?:drop|discard|skip) ${which})$`).exec(t);
  if (no) return { yes: false, id: Number(no[1] || no[2]) || null };
  return null;
}

export const LEVELS = ["remind", "ask", "block"];
const rank = v => LEVELS.indexOf(v == null ? "block" : v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What a change would loosen in a lesson: a lower level, a narrower or different scope, a check
 * removed or changed, a narrower `when`, a lower cap, a pin (no more escalation), or a new rule.
 * Empty when the change only tightens, which anyone may do.
 * @param {any} l the lesson now @param {any} change
 * @returns {string[]}
 */
export function loosens(l, change) {
  const out = [];
  if (change.level !== undefined && rank(change.level) < rank(l.level)) out.push(`lowers the level from ${l.level} to ${change.level}`);
  if (change.scope !== undefined && !same(change.scope, l.scope) && change.scope !== "all") out.push("narrows or moves the scope");
  if (change.check !== undefined && l.check && !same(change.check, l.check)) out.push(change.check ? "changes the check" : "removes the check");
  if (change.when !== undefined && change.when !== (l.when || "always") && change.when !== "always") out.push("narrows when it applies");
  if (change.max_level !== undefined && rank(change.max_level) < rank(l.max_level)) out.push("lowers its highest level");
  if (change.pinned === true && !l.pinned) out.push("pins it, so it never escalates");
  if (change.rule !== undefined && String(change.rule).trim() !== l.rule) out.push("rewrites the rule");
  return out;
}

/** What Stop tells Claude when it sends a turn back. The same words with vyred up or down. */
export function sentBack(blocks, back) {
  const one = back.length === 1;
  return [`Vyre sent this turn back (${blocks} of ${MAX_BLOCKS}). ${one ? "A lesson" : "Lessons"} the user taught ${one ? "is" : "are"} broken:`,
    ...back.map(({ l, problem }) => `- Lesson ${l.id}: ${l.rule} ${problem}`),
    "Fix this now, then finish. Do not mention Vyre or this check unless the user asks."].join("\n");
}

/** What PreToolUse says when a lesson holds a call. */
export const held = (l, problem) => `Vyre lesson ${l.id}, which the user taught: ${l.rule} ${problem}`;
