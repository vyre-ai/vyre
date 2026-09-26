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
//   { kind: "tool",    tool?, command?, instead?, label }  a tool (by name) or a shell command (by
//                                                     pattern) that must not run; `instead` says
//                                                     what to use (npm, when the user wants pnpm)
//   { kind: "path",    pattern, label }               files that must not be changed, by path
//   { kind: "after",   command, when?, label }        after changing a file matching `when` (code,
//                                                     by default), a command matching `command`
//                                                     runs before the turn ends (lint after ts)
//
// Any check may carry `paths`, a pattern over file paths that narrows it to those files: a text
// check with paths applies to what is written to them and not to the reply ("in docs never use
// X"); touched and after count only changes to them. Checks on commands ignore it.
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
export const TESTS = "\\b(npm (run )?test|npm t\\b|node --test|pnpm (run )?test|yarn test|pytest|go test|cargo test|make test|bun test)";
/** Documentation, by path. */
export const DOCS = "\\.(md|mdx|rst|txt|adoc)$|(^|/)docs?/";
const TEST_FILES = "(\\.|_)(test|spec)\\.[a-z0-9]+$|(^|/)(tests?|__tests__)/";

/**
 * Words that make a correction a rule the user means every time. Such lessons start at block.
 * The directives (never, always, no more) count only where they start a clause said to Claude:
 * "never push to main", "please never...", "yes, and always...", not "users never see it" or
 * "the README says never use sed -i". The adverbs (whenever, every time) count anywhere.
 */
const DIRECTIVE = /\b(?:never|always|no more|under no circumstances)\b/gi;
const ADVERB = /\b(from now on|whenever|every time|each time|i told you)\b/i;
/** Weaker words: enough to fit a known check, not enough to propose a free-text rule on their own. */
const SOFT = /\b(?:don'?t|do not|stop|avoid|quit|no longer|remember to|make sure (?:to|you))\b/gi;
const NEG = "(?:never|don'?t|do not|stop|avoid|no more|quit)";
/** What may stand before a directive at the start of a clause said to Claude. */
const LEAD = /(?:^|[.;:!?,(\u2014]\s*|\b(?:please|you|and|but|so|also|then|just|now|ok|okay|yes|no|you should|you must|you'll|you will|remember,?)\s+)$/i;
/** Does a word matching `re` (global) start a clause directed at Claude? */
const directed = (text, re) => { for (const m of text.matchAll(re)) if (LEAD.test(text.slice(0, m.index))) return true; return false; };
/** A question, not an instruction: "can you check why we never push to main?". */
const QUESTION = /^(?:why|can|could|how|what|where|is|are|does|do you|would|should|will you)\b/i;
/**
 * Words that make an instruction about now, not a standing rule: "don't push to main yet",
 * "don't touch migrations for this PR". "In this repo" is a scope, taken off before this is asked.
 */
const TEMPORARY = /\b(?:yet|for now|here|this time|right now|for this (?!repo|repository|project|codebase)[a-z]+)\b/i;
/**
 * Is this a question or an instruction for now, which no lesson comes from? A sentence starting
 * with "when" is a question unless a clause follows a comma ("when you commit, run lint").
 * @param {string} text
 */
export function notARule(text) {
  const t = String(text || "").trim();
  return /\?\s*$/.test(t) || QUESTION.test(t) || (/^when\b/i.test(t) && !t.includes(",")) || TEMPORARY.test(t);
}
/** Scope words: where the user means a rule to hold. They also make a sentence a standing rule. */
const SCOPE_PROJECT = /\s*,?\s*\b(?:in|for|across)\s+this\s+(?:repo(?:sitory)?|project|codebase)\b\s*,?/i;
const SCOPE_ALL = /\s*,?\s*(?:\beverywhere\b|\b(?:in|for|across)\s+(?:all|every)\s+(?:(?:of\s+)?(?:my|our|the)\s+)?(?:repos?|repositories|projects?|codebases?)\b)\s*,?/i;
/** Command-line programs a user bans or prefers by name. A word not here needs a flag to count as a command. */
const PROGRAMS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno", "node", "pip", "pip3", "pipx", "poetry", "uv", "conda", "python", "python3",
  "sed", "awk", "perl", "rm", "mv", "cp", "chmod", "chown", "sudo", "curl", "wget", "git", "gh", "docker", "podman", "kubectl", "helm", "terraform",
  "make", "cargo", "go", "brew", "apt", "apt-get", "jest", "vitest", "mocha", "pytest", "prettier", "eslint", "biome", "tsc", "webpack", "vite", "rsync", "ssh", "scp", "find", "xargs", "grep", "rg"]);
/** Words that end a command in a sentence rather than name a subcommand. */
const CLAUSE = new Set(["for", "in", "on", "with", "without", "to", "here", "there", "again", "anymore", "ever", "instead", "when", "unless", "if", "please", "at", "and", "or", "but", "because", "since", "unless", "on", "the", "a", "any", "this", "that"]);
/** Unquoted phrases that are not a phrase to ban ("never say anything to Dana"). */
const NOT_A_PHRASE = /^(anything|something|nothing|that|this|it|what|how|why|to|about|yes|no|a|an|the|anyone|him|her|them|me|us|so|you|we|i|they|he|she)\b/i;
/** Where "in docs ..." narrows a rule. */
const AREAS = [
  { re: /^(?:docs|documentation|the docs)$/i, name: "docs", paths: DOCS },
  { re: /^(?:markdown|readmes?)$/i, name: "Markdown", paths: "\\.(md|mdx)$" },
  { re: /^(?:tests?|test files|specs?)$/i, name: "tests", paths: TEST_FILES },
];
/** File kinds by the word the user said, as a path pattern. */
const FILE_KINDS = {
  ts: "\\.tsx?$", typescript: "\\.tsx?$", js: "\\.(m|c)?jsx?$", javascript: "\\.(m|c)?jsx?$", py: "\\.py$", python: "\\.py$", go: "\\.go$", rust: "\\.rs$", rs: "\\.rs$",
  css: "\\.(css|scss|sass|less)$", styles: "\\.(css|scss|sass|less)$", sql: "\\.sql$", code: CODE, docs: DOCS, doc: DOCS, markdown: "\\.(md|mdx)$", tests: TEST_FILES,
  files: ".", file: ".", anything: ".",
};

/** Characters people ban by name, with the pattern that finds them. */
const CHARS = [
  { name: /\bem[- ]?dash(es)?\b|\u2014/i, pattern: "\u2014", label: "an em dash (\u2014)", rule: "Never use em dashes." },
  { name: /\ben[- ]?dash(es)?\b|\u2013/i, pattern: "\u2013", label: "an en dash (\u2013)", rule: "Never use en dashes." },
  { name: /\bemojis?\b/i, pattern: "\\p{Extended_Pictographic}", flags: "u", label: "an emoji", rule: "Never use emoji." },
  { name: /\bsemi-?colons?\b/i, pattern: ";", label: "a semicolon", rule: "Never use semicolons in prose." },
];

/** Git verbs as the user says them before another command. */
const GIT = { commit: ["commit", "commits", "committing"], push: ["push", "pushes", "pushing"], merge: ["merge", "merging"], tag: ["tag", "tagging"], rebase: ["rebase", "rebasing"] };

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sentence = s => { const t = s.replace(/\s+/g, " ").trim().slice(0, 240); const u = t.charAt(0).toUpperCase() + t.slice(1); return /[.!?]$/.test(u) ? u : u + "."; };
const tick = s => "`" + s + "`";

/** A shell command, as a pattern: the program at a command's start, a subcommand, flags anywhere after. */
export function commandPattern(prog, sub = "", flags = []) {
  let re = `(?:^|[;&|(\\s])${escape(prog)}`;
  re += sub ? `\\s+${escape(sub)}(?![\\w-])` : "(?![\\w.-])";
  for (const f of flags) re += `[^;&|\\n]*\\s${escape(f)}(?![\\w-])`;
  return re;
}

/** What a few words the user said stand for as a command: the tests, or the words themselves. */
function commandWords(said) {
  const w = said.trim().replace(/^(?:the|a|an)\s+/i, "").replace(/[`"']/g, "");
  if (/^(?:tests?|the test suite|test suite|unit tests)$/i.test(w)) return { re: TESTS, name: "the tests" };
  const words = w.split(/\s+/);
  if (words.length > 3 || !words.every(x => /^[\w:.@/-]+$/.test(x))) return null;
  return { re: `\\b${words.map(escape).join("\\s+")}\\b`, name: w };
}

/**
 * A lesson from something the user said, or null when it is not a correction at all. `scope` is
 * set when the user said where it holds ("in this repo": project, "everywhere": all); `prefers`
 * when they said which tool they prefer ("use pnpm not npm").
 * @param {string} said
 * @returns {{ rule: string, when: string, check: any, level: "remind"|"ask"|"block", scope?: "all"|"project", prefers?: { use: string, over: string } } | null}
 */
export function distill(said) {
  let text = String(said || "").trim();
  if (!text || text.startsWith("/")) return null;
  if (/^never\s*mind\b/i.test(text)) return null;
  const scope = SCOPE_ALL.test(text) ? "all" : SCOPE_PROJECT.test(text) ? "project" : null;
  if (scope) text = text.replace(SCOPE_ALL, " ").replace(SCOPE_PROJECT, " ").replace(/\s+/g, " ").replace(/\s+([.,!?])/g, "$1").replace(/^[,\s]+|[,\s]+$/g, "").trim();
  if (notARule(text)) return null;
  const d = shape(text, Boolean(scope));
  return d && scope ? { ...d, scope } : d;
}

/** @returns {any} */
function shape(text, scoped) {
  const firm = directed(text, DIRECTIVE) || ADVERB.test(text) || scoped, soft = directed(text, SOFT);
  const level = firm ? "block" : "remind";

  // "in docs never use X": the rest, narrowed to those files.
  const area = /^in\s+(?:the\s+|our\s+|all\s+)?([a-z ]+?)\s*,?\s+((?:never|don'?t|do not|always|stop|avoid|no more)\b.+)$/i.exec(text);
  if (area) {
    const a = AREAS.find(x => x.re.test(area[1].trim()));
    if (a) {
      const inner = shape(area[2], scoped);
      if (!inner || !inner.check || !["text", "touched", "after"].includes(inner.check.kind)) return inner && !inner.check ? { ...inner, rule: sentence(text) } : null;
      return { ...inner, rule: `In ${a.name}: ${inner.rule.charAt(0).toLowerCase()}${inner.rule.slice(1)}`, check: { ...inner.check, paths: a.paths, label: `${inner.check.label} in ${a.name}` } };
    }
  }

  // "use pnpm not npm", "use pnpm instead of npm", "don't use npm, use pnpm": both must be programs.
  const use = /\buse\s+`?([a-z][\w.-]*)`?\s*,?\s+(?:not|instead of|rather than|over)\s+`?([a-z][\w.-]*)`?/i.exec(text);
  const swap = /\b(?:don'?t|do not|never|stop)\s+use\s+`?([a-z][\w.-]*)`?\s*[,;.]?\s*(?:use|instead,? use)\s+`?([a-z][\w.-]*)`?/i.exec(text);
  const pair = use ? [use[1], use[2]] : swap ? [swap[2], swap[1]] : null;
  if (pair && PROGRAMS.has(pair[0].toLowerCase()) && PROGRAMS.has(pair[1].toLowerCase()) && pair[0].toLowerCase() !== pair[1].toLowerCase()) {
    const [want, not] = pair.map(x => x.toLowerCase());
    return { rule: `Use ${want}, not ${not}.`, when: "always", level, prefers: { use: want, over: not },
      check: { kind: "tool", tool: "Bash", command: commandPattern(not), instead: want, label: tick(not) } };
  }

  // Rules about order need the user to mean them every time: "run the tests before we merge"
  // is one instruction, "always run lint after editing ts" a standing rule.
  if (firm || soft) {
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

    // "always run lint after editing ts"
    const after = /\brun\s+(.+?)\s+after\s+(?:you\s+)?(?:edit|editing|change|changing|touch|touching|modify|modifying|write|writing)\s+(?:any\s+|a\s+|the\s+)?([a-z]+)(?:\s+files?)?\s*[.!]?$/i.exec(text);
    if (after) {
      const cmd = commandWords(after[1]);
      const kind = FILE_KINDS[/** @type {keyof typeof FILE_KINDS} */ (after[2].toLowerCase())] || (/^[a-z0-9]{1,5}$/i.test(after[2]) && !CLAUSE.has(after[2].toLowerCase()) ? `\\.${escape(after[2].toLowerCase())}$` : null);
      if (cmd && kind) {
        const what = /^(code|files?|anything)$/i.test(after[2]) ? after[2].toLowerCase() : `${after[2]} files`;
        return { rule: `Run ${cmd.name} after changing ${what}.`, when: "always", level,
          check: { kind: "after", command: cmd.re, when: kind, label: `${cmd.name} ran after changing ${what}` } };
      }
    }

    // "run lint before you push", "run the build before deploying"
    const bef = /\brun\s+(.+?)\s+before\s+(?:you\s+|we\s+|each\s+|every\s+|any\s+|a\s+)?(?:run(?:ning)?\s+)?([\w: -]+?)\s*[.!]?$/i.exec(text);
    if (bef) {
      const first = commandWords(bef[1]);
      const y = bef[2].trim().toLowerCase().replace(/^git\s+/, "");
      const git = Object.keys(GIT).find(k => GIT[/** @type {keyof typeof GIT} */ (k)].includes(y));
      const then = git ? { re: `\\bgit\\s+${git}\\b`, name: `git ${git}` } : commandWords(/^\w{3,}ing$/.test(y) ? y.replace(/ing$/, "") : y);
      if (first && then) {
        return { rule: `Run ${first.name} before ${then.name}.`, when: "always", level,
          check: { kind: "before", command: then.re, first: first.re, label: `${first.name} ran before ${then.name}` } };
      }
    }
  }

  if (!firm && !soft) return null;

  if (directed(text, new RegExp(`\\b${NEG}\\b`, "gi"))) {
    // "never use em dashes"
    for (const c of CHARS) if (c.name.test(text)) {
      return { rule: c.rule, when: "always", level, check: { kind: "text", pattern: c.pattern, ...(c.flags ? { flags: c.flags } : {}), label: c.label } };
    }
    // never say "circle back"
    const q = text.match(/\b(?:never|don'?t|do not|stop|avoid)\s+(?:ever\s+)?(?:use|say|write|type|put)\s+(?:the\s+(?:word|phrase)\s+)?["\u201c']([^"\u201d']{1,60})["\u201d']/i);
    if (q) return { rule: `Never write "${q[1]}".`, when: "always", level, check: { kind: "text", pattern: escape(q[1]), flags: "i", label: `"${q[1]}"` } };

    // "never push to main"
    const push = new RegExp(`\\b${NEG}\\s+(?:ever\\s+)?(?:git\\s+)?(?:force[- ])?push(?:ing)?\\s+(?:directly\\s+|straight\\s+)?(?:to|into|on)\\s+(?:the\\s+)?([\\w.-]+?)(?:\\s+branch)?\\s*(?:[.,!;]|$|\\s)`, "i").exec(text);
    if (push && !CLAUSE.has(push[1].toLowerCase()) && !/^(it|anything|that|this|them)$/i.test(push[1])) {
      const b = push[1];
      return { rule: `Never push to ${b}.`, when: "always", level,
        check: { kind: "tool", tool: "Bash", command: `\\bgit\\s+push\\b[^;&|\\n]*[\\s:/+]${escape(b)}(?![\\w./-])`, label: `git push to ${b}` } };
    }

    // "don't use sed -i", "never run git push --force": a known program, or anything with a flag.
    const run = new RegExp(`\\b${NEG}\\s+(?:ever\\s+)?(?:use|using|run|running|call|calling|invoke)\\s+\`?([a-z][\\w.+-]*)((?:\\s+[a-z][\\w-]*)?)((?:\\s+-{1,2}[a-z][\\w.-]*)*)\`?(?=[\\s.,!;\`]|$)`, "i").exec(text);
    if (run) {
      const prog = run[1].toLowerCase();
      let sub = run[2].trim().toLowerCase();
      const flags = run[3].trim() ? run[3].trim().split(/\s+/) : [];
      if (sub && (CLAUSE.has(sub) || !PROGRAMS.has(prog))) sub = "";
      if (PROGRAMS.has(prog) || flags.length) {
        const shown = [prog, sub, ...flags].filter(Boolean).join(" ");
        return { rule: `Never run ${shown}.`, when: "always", level, check: { kind: "tool", tool: "Bash", command: commandPattern(prog, sub, flags), label: tick(shown) } };
      }
    }

    // "don't touch migrations/", "never edit the vendor folder", "don't change package-lock.json"
    const touch = new RegExp(`\\b${NEG}\\s+(?:ever\\s+)?(?:touch|touching|edit|editing|change|changing|modify|modifying|write to|writing to)\\s+(?:anything\\s+(?:in|under)\\s+|files?\\s+(?:in|under)\\s+)?(?:the\\s+)?([\\w.*-]+(?:\\/[\\w.*-]+)*\\/?)(\\s+(?:folder|directory|dir)\\b)?`, "i").exec(text);
    if (touch) {
      const p = touch[1];
      const dir = p.endsWith("/") || Boolean(touch[2]);
      const file = !dir && (/\.[A-Za-z0-9]{1,8}$/.test(p) || p.includes("/"));
      if (dir || file) {
        const clean = p.replace(/\/+$/, "");
        const glob = escape(clean).replace(/\\\*/g, "[^/]*");
        return dir
          ? { rule: `Never change anything in ${clean}/.`, when: "always", level, check: { kind: "path", pattern: `(^|/)${glob}/`, label: `${clean}/` } }
          : { rule: `Never change ${clean}.`, when: "always", level, check: { kind: "path", pattern: `(^|/)${glob}$`, label: clean } };
      }
    }

    // never say circle back; don't use the word "simply" unquoted
    const word = new RegExp(`\\b${NEG}\\s+(?:ever\\s+)?(?:use|using|say|saying|write|writing|type|typing)\\s+the\\s+(?:word|phrase|term|expression)\\s+([a-z][\\w' -]{0,40}?)\\s*(?:[.,!?;:]|$|\\s+(?:in|again|anymore|ever|when|to)\\b)`, "i").exec(text)
      || new RegExp(`\\b(?:never|stop|no more|don'?t|do not)\\s+(?:ever\\s+)?(?:say|saying|write|writing)\\s+([a-z][\\w'-]*(?:\\s+[a-z][\\w'-]*){0,3})\\s*[.!]?$`, "i").exec(text);
    if (word && !NOT_A_PHRASE.test(word[1])) {
      const w = word[1].trim();
      return { rule: `Never write "${w}".`, when: "always", level, check: { kind: "text", pattern: `\\b${escape(w)}\\b`, flags: "i", label: `"${w}"` } };
    }
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
  if (check.paths !== undefined && (typeof check.paths !== "string" || !check.paths || re(check.paths, "i"))) return "paths must be a pattern over file paths";
  if (check.label !== undefined && typeof check.label !== "string") return "label must be a string";
  if (check.kind === "text") return typeof check.pattern === "string" && check.pattern ? re(check.pattern, check.flags || "") : "a text check needs a pattern";
  if (check.kind === "touched") return typeof check.require === "string" && check.require ? re(check.when || CODE, "i") : "a touched check needs require";
  if (check.kind === "before") return typeof check.command === "string" && typeof check.first === "string" ? re(check.command, "i") || re(check.first, "i") : "a before check needs command and first";
  if (check.kind === "tool") {
    if (typeof check.tool !== "string" && typeof check.command !== "string") return "a tool check needs tool or command";
    if (check.tool !== undefined && (typeof check.tool !== "string" || !check.tool)) return "tool must be a tool name";
    if (check.instead !== undefined && (typeof check.instead !== "string" || check.instead.length > 80)) return "instead must be a short string";
    return (typeof check.tool === "string" && re(`^(?:${check.tool})$`, "")) || (typeof check.command === "string" ? re(check.command, "i") : null);
  }
  if (check.kind === "path") return typeof check.pattern === "string" && check.pattern ? re(check.pattern, "i") : "a path check needs a pattern";
  if (check.kind === "after") return typeof check.command === "string" && check.command ? re(check.command, "i") || re(check.when || CODE, "i") : "an after check needs command";
  return `unknown check kind ${check.kind}`;
}

/** The file a writing tool changes, or null for any other tool. */
export function fileOf(tool, input) {
  const key = WRITES[/** @type {keyof typeof WRITES} */ (tool)];
  return key && input && typeof input[key] === "string" ? input[key] : null;
}

/** Does a check's `paths` let this file in? A check without paths lets every file in. */
const allows = (check, file) => !check.paths || (file != null && new RegExp(check.paths, "i").test(file));

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
 * `touched` the files changed this turn. `changes` and `commands` say when each file changed and
 * each command ran this turn, in one order (a time or a counter), for `after` checks. Returns
 * null when it passes or does not apply, or what is wrong, in words Claude can act on.
 * @param {any} check
 * @param {{ text: string|null, touched: string[], changes?: { path: string, at: number }[], commands?: { command: string, at: number }[] }} turn
 * @returns {{ applied: boolean, problem: string|null }}
 */
export function atStop(check, { text, touched, changes, commands }) {
  if (!check) return { applied: false, problem: null };
  if (check.kind === "text") {
    // A text check narrowed to some files is about what goes in them, not the reply.
    if (text == null || check.paths) return { applied: false, problem: null };
    const re = textRe(check);
    const n = (text.match(re) || []).length;
    return { applied: true, problem: n ? `Your reply has ${n === 1 ? check.label : `${n} of ${check.label.replace(/^an? /, "")}`}, at "${around(text, re)}". Write the reply again without ${n === 1 ? "it" : "them"}.` : null };
  }
  const short = f => f.split("/").slice(-2).join("/");
  if (check.kind === "touched") {
    const when = new RegExp(check.when || CODE, "i");
    const want = String(check.require).toLowerCase();
    const is = f => { const l = f.toLowerCase(); return l === want || l.endsWith("/" + want); };
    const changed = touched.filter(f => !is(f) && when.test(f) && allows(check, f));
    if (!changed.length) return { applied: false, problem: null };
    if (touched.some(is)) return { applied: true, problem: null };
    const names = changed.slice(0, 3).map(short).join(", ");
    return { applied: true, problem: `This turn changed ${names}${changed.length > 3 ? ` and ${changed.length - 3} more` : ""} but not ${check.require}. Update ${check.require}, then finish.` };
  }
  if (check.kind === "after") {
    const when = new RegExp(check.when || CODE, "i");
    const list = changes || touched.map(p => ({ path: p, at: -Infinity }));
    const changed = list.filter(f => when.test(f.path) && allows(check, f.path));
    if (!changed.length) return { applied: false, problem: null };
    const last = Math.max(...changed.map(f => f.at));
    const run = new RegExp(check.command, "i");
    if ((commands || []).some(c => c.at >= last && run.test(c.command))) return { applied: true, problem: null };
    const names = [...new Set(changed.map(f => short(f.path)))].slice(0, 3).join(", ");
    return { applied: true, problem: `This turn changed ${names} and nothing matching ${check.command} ran after the last change (${check.label || "the lesson's command"}). Run it, then finish.` };
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
  const file = fileOf(tool, input);
  if (check.kind === "text") {
    const body = written(tool, input);
    if (body == null || !allows(check, file)) return { applied: false, problem: null };
    const re = textRe(check);
    return { applied: true, problem: re.test(body) ? `What this writes has ${check.label}, at "${around(body, re)}". Write it without.` : null };
  }
  if (check.kind === "before" && tool === "Bash" && typeof input?.command === "string" && new RegExp(check.command, "i").test(input.command)) {
    const first = new RegExp(check.first, "i");
    return { applied: true, problem: ran.some(c => first.test(c)) ? null : `Nothing has run that matches ${check.first} since the last change. Run it first.` };
  }
  if (check.kind === "tool") {
    if (check.tool && !new RegExp(`^(?:${check.tool})$`).test(tool)) return { applied: false, problem: null };
    if (check.command !== undefined && !(tool === "Bash" && typeof input?.command === "string" && new RegExp(check.command, "i").test(input.command))) return { applied: false, problem: null };
    return { applied: true, problem: `This runs ${check.label || tool}, which the user ruled out.${check.instead ? ` Use ${check.instead} instead.` : ""}` };
  }
  if (check.kind === "path") {
    const re = new RegExp(check.pattern, "i");
    if (file != null) return re.test(file) ? { applied: true, problem: `This changes ${file}, which the user keeps Claude out of (${check.label || check.pattern}).` } : { applied: false, problem: null };
    if (tool === "Bash" && typeof input?.command === "string" && !readOnly(input.command)) {
      const hit = input.command.split(/[\s;|&()<>=]+/).find(tok => tok && re.test(tok.replace(/^["'`]|["'`]$/g, "")));
      if (hit) return { applied: true, problem: `This command changes ${hit}, which the user keeps Claude out of (${check.label || check.pattern}).` };
    }
    return { applied: false, problem: null };
  }
  return { applied: false, problem: null };
}

// Guards: calls that would weaken what Vyre learned. Anything that makes Vyre stricter is free;
// anything that makes it looser needs a person (ADR 0007, decision 11). These are asked, never
// denied: the user may mean it. A lesson a model can quietly switch off is advice.
//
// Some guards hold whether or not a lesson is active, because what they protect outlives any one
// lesson: the store and the socket, the home's learned/ (installed skills), the Harness's hooks,
// running a hook by hand, Claude Code's plugins and settings, and the human-only tools. The rest
// (the lesson files, the lesson commands, stopping vyred) only matter while a lesson is active.

const USER = "Retiring, relaxing or accepting a lesson, or installing, retiring or dismissing a learned skill, is the user's call, not Claude's.";
const STORE = "This reaches what Vyre learned (its store, socket or lesson files) directly, around the lessons the user taught.";
const DIRECT = "This calls Learning or the Harness directly, around the hooks that check the lessons the user taught.";
const HOOKS = "This changes or runs the Vyre Harness's hooks, which check the lessons the user taught.";
const SETTINGS = "This changes Claude Code's plugins or settings, which could drop Vyre's plugin or its hooks.";
const STOP = "Stopping vyred would stop the lessons the user taught from being checked.";

/** Tools only a person may call: they accept, loosen or retire what Vyre learned. */
export const HUMAN_TOOLS = ["learn.accept", "learn.retire", "learn.relax", "learn.skill-install", "learn.skill-retire", "learn.skill-dismiss"];
const HUMAN = /\blearn\.(?:accept|retire|relax|skill-(?:install|retire|dismiss))\b/;
/** What a script needs to reach vyred: its client, its socket, its header or its tool route. */
const ROUTE = /daemon\/client|socketPath|vyred\.sock|x-vyre-caller|\/v1\/tools\/|--unix-socket/;

/** What in the Vyre home holds or runs the lessons. A write to any of these is asked. */
const GUARDED = ["lessons.json", "learn-offline", "vyre.db", "vyre.db-wal", "vyre.db-shm", "vyred.sock", "vyred.pid", "learned"];
/** Of those, what only matters while a lesson is active. */
const LESSON_FILES = ["lessons.json", "learn-offline"];
/** Commands that only read. A command made only of these, with no redirect into a file, writes nothing. */
const READERS = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ls", "stat", "wc", "file", "diff", "jq", "du", "echo", "printf", "cd", "pwd", "test", "true", "sed", "find", "sort", "uniq", "cut", "tr", "column", "shasum", "sha256sum", "md5", "realpath", "readlink", "basename", "dirname"]);
/** Programs that run a script file named after them. */
const RUNNERS = new Set(["node", "bun", "deno", "tsx", "env", "exec", "nohup", "time"]);

const WRITES = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const untilde = p => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
const within = (p, dir) => p === dir || p.startsWith(dir + path.sep);

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

/** A word of a command as a path: ~, $HOME and $VYRE_HOME expanded, resolved from cwd. Null when it is no path. */
function resolveWord(word, home, cwd) {
  if (!word || word.startsWith("-") || /^[a-z]+:\/\//i.test(word)) return null;
  const w = word.replace(/^(?:\$\{HOME\}|\$HOME)(?=\/|$)/, os.homedir()).replace(/^(?:\$\{VYRE_HOME\}|\$VYRE_HOME)(?=\/|$)/, home);
  if (w.includes("$")) return null;
  if (!w.includes("/") && !cwd) return null;                    // a bare name, and no folder to read it from
  return path.resolve(cwd || "/", untilde(w));
}

/**
 * Why a file is guarded, or null: a guarded name in the home, the loaded plugin's hooks (the
 * plugin root Claude Code gave the hook, or a plugin installed under ~/.claude/plugins), Claude
 * Code's plugins folder and settings files. A hooks folder in some checkout of Vyre is free.
 */
function guardedPath(abs, home, plugin, lessons) {
  if (within(abs, home)) {
    const first = abs === home ? "" : abs.slice(home.length + 1).split(path.sep)[0];
    if (GUARDED.includes(first) && (lessons || !LESSON_FILES.includes(first))) return STORE;
  }
  if (plugin && within(abs, path.join(plugin, "hooks"))) return HOOKS;
  const claude = path.join(os.homedir(), ".claude");
  if (abs === claude || within(abs, path.join(claude, "plugins")) || /\/\.claude\/plugins(\/|$)/.test(abs)) return SETTINGS;
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(abs)) return SETTINGS;
  return null;
}

/** A shell glob as a regex over a whole path. */
const globRe = g => new RegExp("^" + g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

/**
 * A git command's message is prose, not a path or a command: `git commit -m "fix: vyre.db lock"`
 * names nothing. The argument of -m, --message and combined flags like -am is taken out.
 * @param {string} command
 */
function withoutMessages(command) {
  return command.replace(/(\bgit\b[^;&|\n]*?\s)(-[a-zA-Z]*m|--message)(?:=|\s+)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g, "$1$2 ''");
}

/** A hook's entry: hook.js, or the launcher hooks/run.js that an installed plugin starts from. */
const HOOK_FILE = /(^|\/)hook\.js$|(^|\/)hooks\/run\.js$/;

/** Does a shell command run a hook by hand (`node hooks/hook.js enrich`, `... | ./hook.js`)? */
function runsHook(c) {
  return c.split(/\|\|?|&&|;|\n|\$\(|`/).some(seg => {
    const words = seg.trim().split(/\s+/).filter(w => !/^\w+=/.test(w));
    const prog = (words[0] || "").split("/").pop() || "";
    if (HOOK_FILE.test(words[0] || "")) return true;
    return RUNNERS.has(prog) && words.slice(1).some(w => HOOK_FILE.test(w));
  });
}

/**
 * Calls that would weaken what Vyre learned: the human-only tools (accepting, retiring or
 * relaxing a lesson, installing, retiring or dismissing a skill) from inside a turn, by any
 * route; calling Learning or the Harness directly, or running a hook by hand; writing the
 * lessons' files, the store, the socket, the loaded Harness's hooks, Claude Code's plugins or
 * settings; stopping vyred. Asked at every level, by learn.check online and by the hook offline.
 * @param {string} tool @param {any} input
 * @param {{ home?: string, cwd?: string, pluginRoot?: string|null, lessons?: boolean }} [where] the Vyre home (default:
 *   config's), the thread's folder, the loaded plugin's root (default: CLAUDE_PLUGIN_ROOT), and whether a lesson is active
 * @returns {string|null} the reason to ask, or null
 */
export function weakens(tool, input, { home: root, cwd, pluginRoot, lessons = true } = {}) {
  if (/(^|__)learn[._](retire|relax|accept|skill[-_](install|retire|dismiss))$/.test(tool)) return USER;
  const home = path.resolve(root || process.env.VYRE_HOME || path.join(os.homedir(), ".vyre"));
  const pr = pluginRoot === undefined ? process.env.CLAUDE_PLUGIN_ROOT : pluginRoot;
  const plugin = pr ? path.resolve(untilde(pr)) : null;
  const key = WRITES[/** @type {keyof typeof WRITES} */ (tool)];
  if (key && typeof input?.[key] === "string") {
    const why = guardedPath(path.resolve(cwd || home, untilde(input[key])), home, plugin, lessons);
    if (why) return why;
    // A script that calls a human-only tool through vyred's client, socket or route.
    const body = written(tool, input);
    return body && HUMAN.test(body) && ROUTE.test(body) ? USER : null;
  }
  if (tool !== "Bash" || typeof input?.command !== "string") return null;
  // Quotes and backslashes split words without changing them: vy"re" is vyre.
  const c = withoutMessages(input.command).replace(/\\\n/g, " ").replace(/["'`\\]/g, "");
  if (/\bvyre(\.js)?\s+learn\s+skills\s+(install|retire|dismiss)\b/.test(c)) return USER;
  if (lessons && /\bvyre(\.js)?\s+learn\s+(retire|relax|edit|level|accept|scope)\b/.test(c)) return USER;
  if (/\bvyre(\.js)?\s+call\s+(learn|harness)\./.test(c) || /\/v1\/tools\/(learn|harness)\./.test(c)) return DIRECT;
  if (/\bclaude\s+plugins?\s+(disable|uninstall|remove|rm)\b/.test(c)) return SETTINGS;
  if (lessons && (/\bvyre(\.js)?\s+(down|stop|restart)\b/.test(c) || /\b(pkill|killall)\b[^|;&]*\bvyred?\b/.test(c)
    || /\blaunchctl\b[^|;&]*\b(unload|bootout|stop|kill|remove|disable)\b[^|;&]*vyre/i.test(c)
    || /\bsystemctl\b[^|;&]*\b(stop|kill|disable|mask)\b[^|;&]*vyre/.test(c)
    || (/\bkill\b/.test(c) && /vyred\.pid|\bpgrep\b[^|;&]*vyre/.test(c)))) return STOP;
  const spelled = spellings(home);
  if (/--unix-socket|\bnc\b[^|;&]*\s-U\b|\bsocat\b[^|;&]*UNIX/i.test(c) && (/vyre|\$/.test(c) || spelled.some(s => c.includes(s)))) return STORE;
  if (readOnly(c)) return null;
  if (runsHook(c)) return HOOKS;
  if (HUMAN.test(c)) return USER;
  const words = c.split(/[\s;|&()<>=]+/).filter(Boolean);
  // Words that resolve to a guarded file: in the home, the loaded plugin's hooks, Claude Code's
  // plugins or settings. A store name (vyre.db, lessons.json) counts only there: written bare, only
  // with cwd in the home; `rm -rf /tmp/t1/vyre.db` is someone else's file.
  for (const w of words) {
    const abs = resolveWord(w, home, cwd);
    if (!abs) continue;
    const why = guardedPath(abs, home, plugin, lessons);
    if (why) return why;
  }
  if (/(^|[\s/=])\.claude\/settings(\.local)?\.json/.test(c)) return SETTINGS;
  // The home itself, or a guarded name in it. Its watchers/ and modules/ stay free.
  for (const s of spelled) for (let i = c.indexOf(s); i >= 0; i = c.indexOf(s, i + 1)) {
    const after = c.slice(i + s.length);
    if (/^[\w.-]/.test(after)) continue;                       // a longer name that starts the same
    const seg = /^\/([^\s/;|&)]*)/.exec(after);
    if (!seg || !seg[1] || (GUARDED.includes(seg[1]) && (lessons || !LESSON_FILES.includes(seg[1]))) || /[*?[]/.test(seg[1])) return STORE;
  }
  // Globs that could match the home or a guarded file in it: ~/.vy*/lessons.json.
  for (const tok of words) {
    if (!/[*?[]/.test(tok)) continue;
    const re = globRe(tok.replace(/\/+$/, ""));
    if (spelled.some(s => re.test(s) || GUARDED.some(g => re.test(`${s}/${g}`)))) return STORE;
  }
  return null;
}

/**
 * A reply to a proposal: a plain yes or a plain no, and the lesson it names if it names one.
 * The answer may be its own first sentence with a request after it ("Yes, keep it. Now write
 * the intro."). Anything else is neither, so a sentence that happens to start with "no" ("no,
 * I meant the other file") leaves the proposal waiting.
 * @param {string} said
 * @returns {{ yes: boolean, id: number|null } | null}
 */
export function reply(said) {
  const whole = plain(said);
  if (whole) return whole;
  const first = /^([^.!?\n]{1,60})[.!?\n]\s+\S/.exec(String(said || "").trim());
  return first ? plain(first[1]) : null;
}

/** @param {string} said */
function plain(said) {
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
const unpathed = c => { if (!c || typeof c !== "object") return c; const { paths, label, ...rest } = c; return rest; };
/** The same check with its `paths` narrowing taken off: it now holds for every file, which is stricter. */
const widens = (was, now) => Boolean(was && now && was.paths && !now.paths && same(unpathed(was), unpathed(now)));

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
  if (change.check !== undefined && l.check && !same(change.check, l.check) && !widens(l.check, change.check)) {
    out.push(!change.check ? "removes the check" : change.check.paths && same(unpathed(change.check), unpathed(l.check)) ? "narrows the check to some files" : "changes the check");
  }
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
