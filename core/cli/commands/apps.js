// @ts-check
// `vyre apps`: the Mac's apps from the terminal. `vyre apps timer 10 min`, `vyre apps note: buy
// milk`, `vyre apps remind me to call juno at 6`, `vyre apps weather tomorrow`.
//
// The words go to apps.route, which says what they mean without running anything, and then to
// apps.act. An action that sends as the person (a message) is shown first and goes through
// apps.send, which asks this terminal for a person's proof the way every human-only call does.
// `vyre apps`, `find`, `targets` and `setup` are the other tools, plainly printed; --json prints
// what vyred answered, for scripts.
//
// When the app or who a message is for is unclear, vyred asks rather than guesses, and so does
// this: on a terminal it shows the question and the candidates and reads a pick; anywhere else it
// prints the question (as JSON with --json) and exits 3, so a script can tell "asked" from "failed".

import { call as daemonCall } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { callAsPerson } from "../presence.js";
import { createInterface } from "node:readline/promises";
import { out, dim, bold, signal, beacon } from "../style.js";

/** The exit code for "vyred asked a question and no one was there to answer it". */
export const ASKED = 3;
/** Questions asked in a row before giving up, so a loop of unclear answers ends. */
const ROUNDS = 3;

export const USAGE = `
  vyre apps                          the apps on this Mac, and how Vyre reaches each
  vyre apps find <words>             apps whose name matches
  vyre apps targets <app> [words]    what is inside an app: notes, reminder lists
  vyre apps setup clock              Clock's one-time setup (two shortcuts, one click each)
  vyre apps <words...>               do it: timer 10 min, note: buy milk, weather tomorrow,
                                     remind me to call juno at 6, whatsapp juno: running late
  vyre apps -- <words...>            the same, for words that start with find, targets, setup
                                     or list, or with a dash

  --app <App>    read the words as that app's (like @Notes in the Capsule)
  --model        let a small model try words the rules cannot place
  --json         print vyred's answer as JSON

  When the app or who a message is for is unclear, vyre apps asks (Did you mean ...?) on a
  terminal; elsewhere it prints the question and exits 3.
`;

const SUBCOMMANDS = new Set(["find", "targets", "setup", "list"]);

/**
 * Split argv into the subcommand, its words and flags.
 * @param {string[]} args
 */
export function parseArgs(args) {
  /** @type {{ json: boolean, help: boolean, model: boolean, app: string | null }} */
  const flags = { json: false, help: false, model: false, app: null };
  /** @type {string | null} what was wrong with the flags, for a usage error */
  let error = null;
  /** @type {string[]} */
  const words = [];
  let raw = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // Everything after -- is words to route, never a subcommand or a flag.
    if (a === "--") { raw = true; words.push(...args.slice(i + 1)); break; }
    if (a === "--json") flags.json = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--model") flags.model = true;
    else if (a === "--app" || a.startsWith("--app=")) {
      const v = a === "--app" ? args[++i] : a.slice(6);
      if (!v || v.startsWith("-")) error = "--app needs an app name, like --app Notes";
      else flags.app = v;
    }
    else if (/^--?[a-z]/i.test(a)) error = `${a} is not a flag vyre apps knows; put words that start with a dash after --`;
    else words.push(a);
  }
  const sub = !raw && words.length && SUBCOMMANDS.has(words[0].toLowerCase()) ? words.shift()?.toLowerCase() || null : null;
  return { sub, words, flags, error };
}

/** Rows as aligned columns, two spaces apart. @param {string[][]} rows */
function columns(rows) {
  const widths = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] || 0, c.length)), /** @type {number[]} */ ([]));
  return rows.map(r => "  " + r.map((c, i) => (i < r.length - 1 ? c.padEnd(widths[i]) : c)).join("  ").trimEnd());
}

/** @param {{ name: string, tier: string, bundleId: string | null }[]} apps */
export function formatApps(apps) {
  if (!apps.length) return ["  no apps found"];
  return columns(apps.map(a => [a.name, a.tier, a.bundleId || ""]));
}

/** @param {{ id: string, title: string, kind: string }[]} targets @param {string} app */
export function formatTargets(targets, app) {
  if (!targets.length) return [`  nothing to pick in ${app}`];
  return columns(targets.map(t => [t.title, t.kind, t.id]));
}

/** @param {{ ready: boolean, steps: string[], files: string[] }} r */
export function formatSetup(r) {
  return [...r.steps.map(s => `  ${s}`), ...r.files.map(f => `  ${f}`)];
}

/**
 * @typedef {{ data?: any, error?: { code: string, message: string } }} Answer
 * @typedef {{ call(tool: string, input: any, opts?: { timeout?: number }): Promise<Answer>, person(tool: string, input: any): Promise<Answer>,
 *   up(): Promise<boolean>, print(line: string): void, warn(line: string): void,
 *   isTTY?: boolean, ask?(question: string): Promise<string | null> }} Deps
 */

/** One line from the terminal, or null when it closed (Ctrl-D). @param {string} question */
async function askTerminal(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } catch { return null; } finally { rl.close(); }
}

/** @type {Deps} */
const real = {
  call: (tool, input, opts) => daemonCall(tool, input, { timeout: (opts && opts.timeout) || 90_000 }),
  person: (tool, input) => callAsPerson(tool, input),
  up: async () => {
    const r = await ensureUp();
    if (!r.ok) out(beacon("  vyred did not start") + dim(` · its output is in ${r.log}`));
    return r.ok;
  },
  print: line => out(line),
  warn: line => { process.stderr.write(line + "\n"); },
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: askTerminal,
};

/**
 * A question from apps.route, in words: what it asks, the Did you mean line, the numbered
 * candidates. @param {any} r
 */
export function formatQuestion(r) {
  const lines = [`  ${bold(r.ask)} ${dim(`· ${r.text}`)}`];
  if (r.didYouMean) lines.push(`  ${r.didYouMean}`);
  const list = candidates(r);
  list.forEach((c, i) => lines.push(`  ${String(i + 1).padStart(2)}  ${c.label}${c.hint ? dim(`  ${c.hint}`) : ""}`));
  if (!list.length) lines.push(dim(r.needs.app ? "  no app Vyre can send through is on this Mac" : `  no one to pick from in ${r.app}; type a name`));
  return lines;
}

/** @param {any} r @returns {{ label: string, hint?: string, app?: string, to?: string }[]} */
function candidates(r) {
  if (r.needs.app) return r.needs.app.map((/** @type {any} */ a) => ({ label: a.name, hint: a.hint, app: a.name }));
  return (r.needs.recipient || []).map((/** @type {any} */ c) => ({ label: c.title, to: c.title }));
}

/**
 * A person's answer to a question: a number, a name typed out, or Enter for a lone Did you mean.
 * Returns the apps.route input to ask again with, or null for no answer (cancel).
 * @param {any} r @param {string} line @returns {{ text: string, app?: string, to?: string } | null}
 */
export function pick(r, line) {
  const a = String(line || "").trim();
  const list = candidates(r);
  if (!a) return r.didYouMean && list.length ? pickOne(r, list[0]) : null;
  if (/^(y|yes)$/i.test(a) && r.didYouMean && list.length) return pickOne(r, list[0]);
  if (/^\d+$/.test(a)) {
    const c = list[Number(a) - 1];
    return c ? pickOne(r, c) : null;
  }
  const named = list.find(c => c.label.toLowerCase() === a.toLowerCase());
  if (named) return pickOne(r, named);
  // A name not in the list: vyred checks it against the app's people and asks again if unsure.
  return r.needs.app ? { text: r.text, app: a, ...(r.to ? { to: r.to } : {}) } : { text: r.text, app: r.app, to: a };
}

/** @param {any} r @param {{ app?: string, to?: string }} c */
function pickOne(r, c) {
  if (c.app) return { text: r.text, app: c.app, ...(r.to ? { to: r.to } : {}) };
  return { text: r.text, app: r.app, to: c.to };
}

/**
 * Run `vyre apps ...` against injected deps. Returns the exit code.
 * @param {string[]} args @param {Deps} [deps]
 */
export async function runApps(args, deps = real) {
  const { sub, words, flags, error } = parseArgs(args);
  const p = deps.print;
  if (flags.help) { p(USAGE); return 0; }
  if (error) { deps.warn(`  ${error}`); deps.warn(USAGE); return 2; }
  if (!(await deps.up())) return 1;

  /** Print a refusal in words; the exit code says it failed. */
  const fail = (/** @type {{ code: string, message: string }} */ e) => {
    if (flags.json) p(JSON.stringify({ error: e }, null, 2));
    else if (e.code === "unreachable") p(`  vyred is not running ${dim("· vyre up to start it")}`);
    else p(`  ${beacon(e.code)}: ${e.message}`);
    return 1;
  };
  /** @param {Answer} r @param {(d: any) => string[]} show */
  const done = (r, show) => {
    if (r.error) return fail(r.error);
    if (flags.json) p(JSON.stringify(r.data, null, 2));
    else for (const line of show(r.data)) p(line);
    return 0;
  };

  if (sub === "list" || (!sub && !words.length)) return done(await deps.call("apps.list", { limit: 100 }), d => formatApps(d.apps));
  if (sub === "find") {
    if (!words.length) { p("  vyre apps find <words>"); return 1; }
    return done(await deps.call("apps.list", { q: words.join(" ") }), d => formatApps(d.apps));
  }
  if (sub === "targets") {
    if (!words.length) { p("  vyre apps targets <app> [words]"); return 1; }
    const [app, ...q] = words;
    return done(await deps.call("apps.targets", { app, q: q.join(" ") }), d => formatTargets(d.targets, app));
  }
  if (sub === "setup") {
    if (!words.length) { p("  vyre apps setup clock"); return 1; }
    // Signing asks Apple's servers, once for each shortcut: it can take a while.
    return done(await deps.call("apps.setup", { app: words.join(" ") }, { timeout: 180_000 }), formatSetup);
  }

  const text = words.join(" ");
  const routed = await deps.call("apps.route", { text, ...(flags.app ? { app: flags.app } : {}), ...(flags.model ? { model: true } : {}) });
  if (routed.error) return fail(routed.error);
  let r = routed.data;
  for (let round = 0; r.needs; round++) {
    if (flags.json || !deps.isTTY || !deps.ask) {
      if (flags.json) p(JSON.stringify(r, null, 2));
      else { for (const line of formatQuestion(r)) p(line); p(dim("  run it on a terminal to pick, or say it again with the name and app")); }
      return ASKED;
    }
    if (round >= ROUNDS) { p(`  ${beacon("not sure")}: ${r.reason}`); return 1; }
    for (const line of formatQuestion(r)) p(line);
    const line = await deps.ask(r.didYouMean ? "  pick one (Enter for the first): " : "  pick one: ");
    if (/^\s*\d+\s*$/.test(line || "") && !candidates(r)[Number(line) - 1]) { p(`  there is no ${String(line).trim()} in the list`); continue; }
    const next = pick(r, line || "");
    if (!next) { p(dim("  nothing sent")); return 1; }
    const again = await deps.call("apps.route", next);
    if (again.error) return fail(again.error);
    r = again.data;
  }
  if (r.ambiguous) {
    if (flags.json) p(JSON.stringify(r, null, 2));
    else p(`  ${beacon("not sure")}: ${r.reason}`);
    return 1;
  }
  const input = { app: r.app, action: r.action, args: r.args };
  if (r.sends) {
    // Said before any proof is asked for, so the person knows what they are approving. With
    // --json it goes to stderr, keeping stdout for the JSON.
    if (flags.json) deps.warn(`  ${r.said}`);
    else p(`  ${bold(r.said)}`);
    return done(await deps.person("apps.send", input), d => [`  ${signal("●")} ${d.said}`]);
  }
  return done(await deps.call("apps.act", input), d => [`  ${signal("●")} ${d.said}`]);
}

export default {
  name: "apps", order: 47, usage: "vyre apps <words...>", summary: "drive the Mac's apps: timer 10 min, note: buy milk, weather tomorrow",
  run: (/** @type {string[]} */ args) => runApps(args),
};
