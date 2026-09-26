// @ts-check
// run: one watcher run in a child process, from the parent's side.
//
// The child gets no environment, a hard timeout, and (on Node with a permission model) read
// access to its own folder and the runner and nothing else: no writes, no child processes, no
// workers. It can reach the network; watching the network is the point.
//
// Vault values reach the child one at a time, only for names in the watcher's own `needs`, and
// every value released during a run is scrubbed from its log lines and its error before either
// is kept. An item that carries a released value fails the run: an item is filed into a project
// and taught to Memory, and a credential must never end up in either.

import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNNER = fileURLToPath(new URL("./runner.js", import.meta.url));
// The permission model is `--permission` from Node 22.13 and 23.5, and `--experimental-permission`
// in the 22 releases before that. Every Node that Vyre supports (22.5 on) has one or the other.
const [major, minor] = process.versions.node.split(".").map(Number);
const FLAG = major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13) ? "--permission" : "--experimental-permission";
export const SANDBOXED = major >= 22;

export const LIMITS = { items: 1000, itemBytes: 4000, logLines: 200, lineChars: 500 };

/**
 * @typedef {{ items: any[], logs: string[], cursor: any, error: string|null, ms: number, sandboxed: boolean }} Result
 */

/**
 * Run a watcher once.
 * @param {{ dir: string, needs: string[], since: any, hook?: any, timeoutMs: number,
 *   fetch: (name: string) => Promise<string>, signal?: AbortSignal }} opts
 * @returns {Promise<Result>}
 */
export function runOnce({ dir, needs, since, hook = null, timeoutMs, fetch, signal }) {
  const started = Date.now();
  const real = fs.realpathSync(dir);
  const runner = fs.realpathSync(RUNNER);
  const execArgv = SANDBOXED ? [FLAG,`--allow-fs-read=${real}`, `--allow-fs-read=${runner}`] : [];
  /** @type {string[]} */ const released = [];
  const items = [], logs = [];
  let dropped = 0, cursor = null, error = /** @type {string|null} */ (null), finished = false;

  const scrub = s => { let out = String(s); for (const v of released) if (v) out = out.split(v).join("[vault value]"); return out; };
  const logLine = line => {
    if (logs.length >= LIMITS.logLines) { dropped++; return; }
    logs.push(scrub(line).slice(0, LIMITS.lineChars));
  };

  return new Promise(resolve => {
    const child = fork(runner, [], { execArgv, env: {}, cwd: real, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json" });
    let stderr = "";
    child.stdout?.on("data", c => String(c).split("\n").filter(Boolean).forEach(logLine));
    child.stderr?.on("data", c => { stderr = (stderr + c).slice(-4000); });
    const fail = msg => { if (!error) error = scrub(msg); };
    const timer = setTimeout(() => { fail(`took longer than ${Math.round(timeoutMs / 1000)}s and was stopped`); child.kill("SIGKILL"); }, timeoutMs);
    const abort = () => { fail("stopped because vyred is stopping"); child.kill("SIGKILL"); };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });

    child.on("message", async (/** @type {any} */ m) => {
      if (!m || typeof m !== "object") return;
      if (m.t === "log") logLine(m.line);
      else if (m.t === "emit") {
        if (items.length >= LIMITS.items) { fail(`emitted more than ${LIMITS.items} items in one run; fetch only what is new since \`since\``); child.kill("SIGKILL"); return; }
        items.push(m.item);
      } else if (m.t === "vault") {
        const name = String(m.name);
        if (!needs.includes(name)) { child.connected && child.send({ t: "vault", id: m.id, error: `this watcher does not list "${name}" under needs in watcher.json` }); return; }
        try {
          const value = String(await fetch(name));
          released.push(value);
          child.connected && child.send({ t: "vault", id: m.id, value });
        } catch (e) { child.connected && child.send({ t: "vault", id: m.id, error: /** @type {Error} */ (e).message }); }
      } else if (m.t === "done") { finished = true; cursor = m.cursor; }
      else if (m.t === "error") { finished = true; fail(m.message); }
    });
    child.on("exit", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!finished) fail(`stopped before it finished (exit ${code})${stderr ? ": " + lastLines(stderr) : ""}`);
      if (dropped) logs.push(`(${dropped} more log lines dropped)`);
      // A released value inside an item would be filed and taught; refuse the run instead.
      if (!error && released.some(v => v && items.some(i => JSON.stringify(i).includes(v)))) {
        fail("an item carried a value from the vault; emit links and ids, never credentials");
      }
      resolve({ items: error ? [] : items, logs, cursor: error ? null : cursor, error, ms: Date.now() - started, sandboxed: SANDBOXED });
    });
    child.send({ t: "run", entry: pathToFileURL(path.join(real, "watch.js")).href, since: since ?? null, hook });
  });
}

function lastLines(s) {
  return s.trim().split("\n").filter(l => !/^\s+at /.test(l) && !/^Node\.js v/.test(l)).slice(-3).join(" / ").slice(0, 400);
}

/**
 * Check what a run emitted and put it in one shape. Throws on the first bad item, naming it, so
 * a dry run tells Claude exactly what to fix.
 * @param {any[]} raw
 */
export function normalize(raw) {
  const out = [], seen = new Set();
  raw.forEach((item, i) => {
    const where = `item ${i + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${where} is not an object; emit({ id, title, ... })`);
    const id = item.id;
    if (!((typeof id === "string" && id.trim()) || Number.isFinite(id))) throw new Error(`${where} has no id; every item needs a stable id so a repeat is never filed twice`);
    const key = String(id).slice(0, 200);
    const size = Buffer.byteLength(JSON.stringify(item));
    if (size > LIMITS.itemBytes) throw new Error(`${where} (${key}) is ${size} bytes; items are small, at most ${LIMITS.itemBytes}. Link to the document instead`);
    if (seen.has(key)) return;                      // the same thing twice in one run is one item
    seen.add(key);
    out.push({ ...item, id: key, at: when(item.at), title: item.title == null ? null : String(item.title).slice(0, 300) });
  });
  return out;
}

/** An item's time as ms: a date string, ms, or seconds (anything before 2001 in ms is seconds). */
function when(at) {
  if (at == null || at === "") return null;
  if (typeof at === "number") return at < 1e12 ? Math.round(at * 1000) : Math.round(at);
  const t = Date.parse(String(at));
  return Number.isFinite(t) ? t : null;
}
