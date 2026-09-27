// @ts-check
// verbs: every `vyre` command's verbs, with their arguments and flags, as data. `vyre commands
// --json` prints it for the Capsule's autocomplete and chat's / menu (docs/reference/cli-json.md).
//
// A command may list its verbs itself (`verbs` on its default export). One that does not has them
// read from its usage line, which follows one grammar:
//
//   vyre relay [status|pair|remove <id>|trust <id> [--off]|on [--url u]] [--json]
//   vyre connect list|add|remove|test
//
// The first word of each alternative is the verb. <x> is a required argument, [x] an optional
// one, <x...> or [x...] takes more than one, --flag v takes a value, --flag alone is a switch.

/**
 * @typedef {{ name: string, required: boolean, repeat?: boolean, choices?: string[] }} Arg
 * @typedef {{ name: string, value?: string, choices?: string[] }} Flag
 * @typedef {{ verb: string, aliases?: string[], summary?: string, args: Arg[], flags: Flag[], read?: boolean, person?: boolean, live?: boolean }} Verb
 */

/** Words that only read, so a surface may run them without asking. */
const READS = new Set(["list", "ls", "status", "show", "get", "history", "devices", "keys", "pending", "search", "logs", "stats",
  "items", "tools", "modules", "usage", "health", "audit", "models", "check", "signals", "corrections", "tasks", "commands", "watch", "agenda", "queue", "asks"]);
/** Verbs that follow something as it changes. */
const LIVE = new Set(["watch", "totp"]);

/** Split on `sep` outside brackets. @param {string} s @param {string} sep */
function top(s, sep) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "[" || ch === "<" || ch === "(") depth++;
    if (ch === "]" || ch === ">" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

/** Tokens outside brackets, keeping each bracketed group whole. @param {string} s */
const tokens = s => top(s, " ");

/** The inside of a leading [ ... ] with its match, or null. @param {string} s */
function bracketed(s) {
  if (!s.startsWith("[")) return null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "[") depth++;
    if (s[i] === "]" && --depth === 0) return { inner: s.slice(1, i), rest: s.slice(i + 1).trim() };
  }
  return null;
}

/**
 * Arguments and flags from the words after a verb.
 * @param {string[]} words
 * @returns {{ args: Arg[], flags: Flag[] }}
 */
export function argsOf(words) {
  /** @type {Arg[]} */ const args = [];
  /** @type {Flag[]} */ const flags = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "…" || w === "...") continue;
    if (w.startsWith("--")) {
      const [name, inline] = w.slice(2).split("=");
      const next = words[i + 1];
      if (inline) flags.push(flagOf(name, inline));
      else if (next && isValue(next)) { flags.push(flagOf(name, next)); i++; }
      else flags.push({ name });
      continue;
    }
    if (w.startsWith("[") && w.endsWith("]")) {
      const inner = w.slice(1, -1).trim();
      if (inner.startsWith("--")) { const f = argsOf(tokens(inner)).flags; flags.push(...f); continue; }
      const sub = argsOf(tokens(inner));
      for (const a of sub.args) args.push({ ...a, required: false });
      flags.push(...sub.flags);
      continue;
    }
    if (w.startsWith("<") && w.endsWith(">")) { args.push(argOf(w.slice(1, -1), true)); continue; }
    if (/^[a-z][a-z0-9-]*(\|[a-z][a-z0-9-]*)+$/.test(w)) { args.push({ name: "choice", required: true, choices: w.split("|") }); continue; }
    if (/^[a-z][a-z0-9_-]*$/.test(w)) args.push(argOf(w, true));
  }
  return { args, flags };
}

/** A flag's value word: `u`, `<file>`, `a|b|c`. @param {string} w */
const isValue = w => /^<[^>]+>$/.test(w) || /^[a-z][a-z0-9_-]*$/.test(w) || /^[a-z0-9-]+(\|[a-z0-9-]+)+$/.test(w);

/** @param {string} name @param {string} value */
function flagOf(name, value) {
  const v = value.replace(/^<|>$/g, "");
  return /\|/.test(v) ? { name, value: "choice", choices: v.split("|") } : { name, value: v };
}

/** @param {string} raw @param {boolean} required */
function argOf(raw, required) {
  const repeat = /\.\.\.$|…$/.test(raw);
  const name = raw.replace(/\.\.\.$|…$/, "").trim();
  return /\|/.test(name) ? { name: "choice", required, choices: name.split("|"), ...(repeat ? { repeat } : {}) } : { name, required, ...(repeat ? { repeat } : {}) };
}

/**
 * The verbs a usage line names, or [] when it names none (the command takes words itself).
 * @param {string} line "vyre relay [status|pair|...] [--json]"
 * @param {string} name the command
 * @returns {Verb[]}
 */
export function parseUsage(line, name) {
  let s = String(line || "").trim().split("\n")[0].trim();
  const prefix = `vyre ${name}`;
  if (!s.startsWith(prefix)) return [];
  s = s.slice(prefix.length).trim();
  let group = null;
  const b = bracketed(s);
  if (b) group = b.inner;
  else {
    const bare = s.replace(/\s*\[--json\]\s*$/, "");
    const alts = top(bare, "|");
    if (alts.length > 1 && alts.every(a => /^[a-z][a-z.-]*(\s|$)/.test(a))) group = bare;
  }
  if (!group) return [];
  const alts = top(group, "|");
  // One word in brackets is an optional argument (vyre new [name]), not a verb.
  if (alts.length < 2) return [];
  /** @type {Verb[]} */
  const verbs = [];
  for (const alt of alts) {
    const words = tokens(alt);
    const verb = words[0];
    if (!verb || !/^[a-z][a-z.-]*$/.test(verb)) continue;
    const { args, flags } = argsOf(words.slice(1));
    verbs.push(mark({ verb, args, flags }));
  }
  return verbs;
}

/** read and live from the verb's word, unless the command said. @param {Verb} v */
function mark(v) {
  return { ...v, read: v.read ?? READS.has(v.verb), ...(v.live ?? LIVE.has(v.verb) ? { live: true } : {}) };
}

/**
 * One command's verbs: its own list when it has one, else its usage line's.
 * @param {{ name: string, usage?: string, verbs?: any[] }} c
 * @returns {Verb[]}
 */
export function verbsOf(c) {
  if (Array.isArray(c.verbs)) {
    return c.verbs.map(v => {
      const parsed = typeof v.usage === "string" ? argsOf(tokens(v.usage)) : { args: [], flags: [] };
      return mark({ verb: v.verb, ...(v.aliases ? { aliases: v.aliases } : {}), ...(v.summary ? { summary: v.summary } : {}),
        args: v.args || parsed.args, flags: v.flags || parsed.flags,
        ...(v.read !== undefined ? { read: v.read } : {}), ...(v.person ? { person: true } : {}), ...(v.live ? { live: true } : {}) });
    });
  }
  return parseUsage(c.usage || "", c.name);
}

/**
 * What a command takes when it has no verbs: `vyre send <thread> <text...>`.
 * @param {{ name: string, usage?: string }} c
 */
export function ownArgs(c) {
  const s = String(c.usage || "").split("\n")[0].trim();
  const prefix = `vyre ${c.name}`;
  return s.startsWith(prefix) ? argsOf(tokens(s.slice(prefix.length).trim())) : { args: [], flags: [] };
}
