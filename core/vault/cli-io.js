// @ts-check
// cli-io — the terminal side of the Vault: prompts that never echo, a scrubber for `vyre vault
// run`, and the small parsers the vault command needs.
//
// Why these live here and not in the command file: each one guards a way a value could reach a
// screen, and each needs a test that proves it. A hidden prompt that prints asterisks tells a
// shoulder-surfer the length; one that forgets to restore raw mode leaves the terminal broken and
// the next command echoing nothing. The scrubber must catch a value even when the child writes
// it across two reads of a pipe, which only a chunk-level test shows. None of this reads or
// holds a value longer than the call that needs it.

import readline from "node:readline";
import { Transform } from "node:stream";
import { CONCEALED } from "../../lib/scrub.js";

export { CONCEALED };

/**
 * Ask for a secret. On a terminal: raw mode, nothing echoed (not even asterisks), backspace
 * edits, Enter finishes, Ctrl-C rejects with Error("cancelled"). Raw mode is always restored and
 * input paused, whatever happens. Without a terminal (a pipe, a test), reads all of input and
 * strips one trailing newline, so `printf %s "$X" | vyre vault put name` works.
 * @param {string} question
 * @param {{ input?: any, output?: any }} [opts]
 * @returns {Promise<string>}
 */
export function hiddenPrompt(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return readAll(input).then(s => s.replace(/\r?\n$/, ""));
  return new Promise((resolve, reject) => {
    output.write(question);
    let value = "";
    const done = (/** @type {Error|null} */ err) => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      try { input.setRawMode(false); } catch { /* the stream may already be gone */ }
      input.pause();
      output.write("\n");
      if (err) reject(err); else resolve(value);
      value = "";
    };
    const onEnd = () => done(null);
    const onData = (/** @type {Buffer|string} */ chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(null);
        if (ch === "\u007f" || ch === "\b") { value = [...value].slice(0, -1).join(""); continue; }
        if (ch < " ") continue; // other control keys and escape sequences add nothing
        value += ch;
      }
    };
    try { input.setRawMode(true); } catch (e) { reject(e); return; }
    input.setEncoding("utf8");
    input.on("data", onData);
    input.on("end", onEnd);
    input.resume();
  });
}

/**
 * Ask for something that is not secret (a username, a card expiry), echoed as typed.
 * @param {string} question
 * @param {{ input?: any, output?: any }} [opts]
 * @returns {Promise<string>}
 */
export function visiblePrompt(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input, output, terminal: false });
    let answered = false;
    rl.question(question, a => { answered = true; rl.close(); resolve(a.trim()); });
    rl.on("close", () => { if (!answered) resolve(""); });
  });
}

/** @param {any} input @returns {Promise<string>} */
function readAll(input) {
  return new Promise((resolve, reject) => {
    const parts = [];
    input.on("data", c => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    input.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    input.on("error", reject);
    input.resume();
  });
}

/**
 * Replaces every value it was given (4 characters or longer) with `<concealed by vyre>`, even
 * when a value arrives split across chunks. It works on bytes (as latin1 strings, one char per
 * byte), so a split inside a multi-byte character cannot hide a match, and holds back only the
 * tail that could still be the start of a value.
 */
export class Scrubber extends Transform {
  /** @param {string[]} values */
  constructor(values) {
    super();
    const bytes = [...new Set((values || []).map(v => String(v ?? "")))]
      .map(v => Buffer.from(v, "utf8").toString("latin1"))
      .filter(v => v.length >= 4)
      .sort((a, b) => b.length - a.length);
    /** @private */ this.values = bytes;
    /** @private */ this.max = bytes.length ? bytes[0].length : 0;
    /** @private */ this.pending = "";
    /** @private */ this.mark = Buffer.from(CONCEALED).toString("latin1");
  }

  /** Scan `s`; unless `final`, stop at a tail that could still become a value. @private */
  scan(s, final) {
    let outp = "", run = 0, i = 0;
    while (i < s.length) {
      const hit = this.values.find(v => s.startsWith(v, i));
      if (hit) { outp += s.slice(run, i) + this.mark; i += hit.length; run = i; continue; }
      if (!final && s.length - i < this.max) {
        const rest = s.slice(i);
        if (this.values.some(v => v.startsWith(rest))) break;
      }
      i++;
    }
    outp += s.slice(run, i);
    return { emit: outp, keep: s.slice(i) };
  }

  _transform(chunk, _enc, cb) {
    if (!this.max) { cb(null, chunk); return; }
    const { emit, keep } = this.scan(this.pending + Buffer.from(chunk).toString("latin1"), false);
    this.pending = keep;
    cb(null, emit ? Buffer.from(emit, "latin1") : undefined);
  }

  _flush(cb) {
    const { emit } = this.scan(this.pending, true);
    this.pending = "";
    if (emit) this.push(Buffer.from(emit, "latin1"));
    cb();
  }
}

/**
 * `vyre vault run` arguments: items before `--`, the command after. An item is `name`,
 * `name.field`, `VAR=name` or `VAR=name.field`; the field is whatever follows the last dot.
 * @param {string[]} args
 * @returns {{ items: { name: string, env?: string, field?: string }[], cmd: string[] }}
 */
export function parseRunArgs(args) {
  const at = args.indexOf("--");
  const usage = "vyre vault run <name...> -- <command...>";
  if (at < 0) throw new Error(`put -- between the items and the command: ${usage}`);
  const left = args.slice(0, at), cmd = args.slice(at + 1);
  if (!left.length) throw new Error(`name at least one item before --: ${usage}`);
  if (!cmd.length) throw new Error(`no command after --: ${usage}`);
  const items = left.map(a => {
    /** @type {{ name: string, env?: string, field?: string }} */
    const item = { name: a };
    const eq = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a);
    if (eq) { item.env = eq[1]; item.name = eq[2]; }
    const dot = item.name.lastIndexOf(".");
    if (dot > 0 && dot < item.name.length - 1) { item.field = item.name.slice(dot + 1); item.name = item.name.slice(0, dot); }
    if (!item.name || item.name.endsWith(".")) throw new Error(`${JSON.stringify(a)} is not an item: use name, name.field, VAR=name or VAR=name.field`);
    return item;
  });
  return { items, cmd };
}

/** An item name as an environment variable name: `stripe-live` becomes `STRIPE_LIVE`. */
export function envName(name) {
  const s = String(name).toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return /^[0-9]/.test(s) ? "_" + s : s;
}

/**
 * A small flag parser. `spec.string` flags take a value (`--kind x` or `--kind=x`), `spec.list`
 * flags take one and repeat (`--host a --host b`), `spec.boolean` flags take none and accept a
 * `--no-` form. Anything after a bare `--` is positional. Unknown flags throw.
 * @param {string[]} args
 * @param {{ string?: string[], list?: string[], boolean?: string[] }} [spec]
 * @returns {{ _: string[], [flag: string]: any }}
 */
export function flags(args, spec = {}) {
  const str = new Set(spec.string || []), list = new Set(spec.list || []), bool = new Set(spec.boolean || []);
  /** @type {{ _: string[], [flag: string]: any }} */
  const res = { _: [] };
  for (const l of list) res[l] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { res._.push(...args.slice(i + 1)); break; }
    if (!a.startsWith("--") || a.length === 2) { res._.push(a); continue; }
    let key = a.slice(2), val;
    const eq = key.indexOf("=");
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (bool.has(key)) { res[key] = val === undefined ? true : !["false", "0", "no"].includes(val); continue; }
    if (key.startsWith("no-") && bool.has(key.slice(3))) { res[key.slice(3)] = false; continue; }
    if (str.has(key) || list.has(key)) {
      if (val === undefined) {
        if (i + 1 >= args.length) throw new Error(`--${key} needs a value`);
        val = args[++i];
      }
      if (list.has(key)) res[key].push(val); else res[key] = val;
      continue;
    }
    throw new Error(`unknown flag --${key}`);
  }
  return res;
}
