// @ts-check
// run: one watcher run in a child process, from the parent's side.
//
// The child gets no environment, a hard timeout, and (on Node with a permission model) read
// access to its own folder and the runner and nothing else: no writes, no child processes, no
// workers. It can reach the network; watching the network is the point.
//
// Credentials never reach the child. The parent attaches the vault item a watcher named under `net`
// to requests for that host only, and scrubs it (and its base64, hex and URL forms) from the
// response, the log lines and the error before any is kept. An item that carries one fails the run:
// an item is filed into a project and taught to Memory, and a credential must never end up in either.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mediatedFetch, sandboxIdentity, getWall } from "../../lib/sandbox/index.js";

const RUNNER = fileURLToPath(new URL("./runner.js", import.meta.url));
// The permission model is `--permission` from Node 22.13 and 23.5, and `--experimental-permission`
// in the 22 releases before that. Every Node that Vyre supports (22.5 on) has one or the other.
const [major, minor] = process.versions.node.split(".").map(Number);
const FLAG = major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13) ? "--permission" : "--experimental-permission";
export const SANDBOXED = major >= 22;

export const LIMITS = { channelBytes: 64_000_000, channelLine: 1_000_000, asks: 20, askChars: 8000, askReply: 4000, items: 1000, itemBytes: 4000, logLines: 200, lineChars: 500 };

/**
 * @typedef {{ items: any[], logs: string[], cursor: any, error: string|null, ms: number, sandboxed: boolean }} Result
 */

/**
 * Run a watcher once.
 * @param {{ dir: string, needs: string[], since: any, hook?: any, timeoutMs: number,
 *   fetch: (name: string, field?: string) => Promise<string>, signal?: AbortSignal,
 *   hosts?: string[]|null, netAuth?: (url: URL) => Promise<{ host: string, header: string, value: string }|undefined>,
 *   askFn?: ((prompt: string) => Promise<string>)|null, viaRequest?: ((url: URL, init: any) => Promise<any>)|null, netOptions?: object, identity?: ReturnType<typeof sandboxIdentity> }} opts
 * @returns {Promise<Result>}
 */
export async function runOnce(opts) {
  // Fail closed: no wall that keeps a child off the network means no watcher runs, said in words.
  const found = opts.wall === undefined ? await getWall() : { wall: opts.wall, why: opts.wall ? opts.wall.why : "no wall" };
  if (!found.wall) {
    return { items: [], logs: [], cursor: null, ms: 0, sandboxed: false, isolated: false, wall: null, unisolated: true,
      error: `watchers cannot run on this machine: it has no way to keep a watcher off the network (${found.why}). Nothing was run.` };
  }
  return runIn(found.wall, opts);
}

function runIn(wall, { dir, needs, since, hook = null, timeoutMs, fetch, signal, hosts = null, netAuth, askFn = null, viaRequest = null, netOptions = {}, identity = sandboxIdentity() }) {
  const started = Date.now();
  const real = fs.realpathSync(dir);
  const runner = fs.realpathSync(RUNNER);
  const execArgv = SANDBOXED ? [FLAG,`--allow-fs-read=${real}`, `--allow-fs-read=${runner}`] : [];
  /** @type {string[]} */ const released = [];
  const items = [], logs = [];
  let asks = 0, dropped = 0, cursor = null, error = /** @type {string|null} */ (null), finished = false;

  const scrub = s => { let out = String(s); for (const v of released) if (v) out = out.split(v).join("[vault value]"); return out; };
  const logLine = line => {
    if (logs.length >= LIMITS.logLines) { dropped++; return; }
    logs.push(scrub(line).slice(0, LIMITS.lineChars));
  };

  return new Promise(resolve => {
    // The child talks to its parent in lines of JSON on stdin and stdout, so any launcher that gives
    // a child pipes can start it, inside the wall.
    const nodeBin = fs.realpathSync(process.execPath);
    const { cmd, args } = wall.wrap([process.execPath, ...execArgv, runner], { ro: [real, runner, nodeBin, path.dirname(nodeBin)], cwd: real });
    const child = spawn(cmd, args, { env: {}, cwd: real, ...(identity.uid != null ? { uid: identity.uid, gid: identity.gid ?? identity.uid } : {}), stdio: ["pipe", "pipe", "pipe"] });
    const send = obj => { if (child.stdin && child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n"); };
    child.stdin?.on("error", () => {});
    // The channel carries messages and nothing else: a line over 1 MB, a total over 64 MB, or a line
    // that is not a message fails the run. The child's console and log() go to stderr, not here.
    let line = "", total = 0;
    child.stdout?.on("data", c => {
      total += c.length; line += c;
      if (total > LIMITS.channelBytes) { fail("sent more than the channel allows"); child.kill("SIGKILL"); return; }
      for (let i = line.indexOf("\n"); i >= 0; i = line.indexOf("\n")) {
        const one = line.slice(0, i); line = line.slice(i + 1);
        let m; try { m = JSON.parse(one); } catch { fail("wrote something to its channel that is not a message"); child.kill("SIGKILL"); return; }
        if (!m || typeof m !== "object" || Array.isArray(m)) { fail("wrote something to its channel that is not a message"); child.kill("SIGKILL"); return; }
        child.emit("message", m);
      }
      if (line.length > LIMITS.channelLine) { fail("sent a message over the 1 MB line limit"); child.kill("SIGKILL"); }
    });
    let stderr = "";
    let errLine = "", errTotal = 0;
    child.stderr?.on("data", c => {
      stderr = (stderr + c).slice(-4000);
      errTotal += c.length; errLine += c;
      for (let i = errLine.indexOf("\n"); i >= 0; i = errLine.indexOf("\n")) { const one = errLine.slice(0, i); errLine = errLine.slice(i + 1); if (one) logLine(one); }
      if (errLine.length > 100_000) errLine = "";
      if (errTotal > 4_000_000) { fail("wrote too much to its log"); child.kill("SIGKILL"); }
    });
    const fail = msg => { if (!error) error = scrub(msg); };
    const timer = setTimeout(() => { fail(`took longer than ${Math.round(timeoutMs / 1000)}s and was stopped`); child.kill("SIGKILL"); }, timeoutMs);
    const abort = () => { fail("stopped because vyred is stopping"); child.kill("SIGKILL"); };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });

    child.on("message", async (/** @type {any} */ m) => {
      if (!m || typeof m !== "object") return;
      if (m.t === "emit") {
        if (items.length >= LIMITS.items) { fail(`emitted more than ${LIMITS.items} items in one run; fetch only what is new since \`since\``); child.kill("SIGKILL"); return; }
        items.push(m.item);
      } else if (m.t === "vault") {
        // A raw credential never enters the child: it could send it to any host or use it to write.
        send({ t: "vault", id: m.id, error: "a watcher does not handle credentials; declare the host under net in watcher.json with its vault item, and Vyre attaches it to that host's requests" });
      } else if (m.t === "ask") {
        const reply = body => send({ t: "ask", id: m.id, ...body });
        try {
          if (!askFn) throw new Error("this watcher did not declare ask in watcher.json, like { \"ask\": { \"dailyUsd\": 0.25 } }");
          if (++asks > LIMITS.asks) throw new Error(`ask is limited to ${LIMITS.asks} calls in one run`);
          const prompt = String(m.prompt || "");
          if (prompt.length > LIMITS.askChars) throw new Error(`ask takes at most ${LIMITS.askChars} characters; send the part that matters`);
          if (released.some(v => v && prompt.includes(v))) throw new Error("the prompt carries a value from the vault");
          reply({ text: scrub(String(await askFn(prompt))).slice(0, LIMITS.askReply) });
        } catch (e) { reply({ error: /** @type {Error} */ (e).message }); }
      } else if (m.t === "fetch") {
        // The child has no network of its own; this is its only way out (lib/sandbox/fetch.js).
        const reply = body => send({ t: "fetch", id: m.id, ...body });
        try {
          const url = new URL(String(m.url));
          if (!hosts || !hosts.length) throw new Error("this watcher declares no hosts; list each host it reads under net in watcher.json, like { \"api.example.com\": {} }");
          if (!hosts.includes(url.hostname)) throw new Error(`${url.hostname} is not one of this watcher's declared hosts`);
          // An api-credential host: the vault makes the call itself (a read, scoped to this watcher's grant).
          const viaVault = viaRequest ? await viaRequest(url, m.init || {}) : undefined;
          if (viaVault) { viaVault.body = scrub(String(viaVault.body ?? "")); for (const k of Object.keys(viaVault.headers || {})) viaVault.headers[k] = scrub(viaVault.headers[k]); reply({ result: viaVault }); return; }
          const auth = netAuth ? await netAuth(url) : undefined;
          if (auth) released.push(...forms(auth.value), ...forms(auth.value.replace(/^\S+ /, "")));
          const r = await mediatedFetch(url.href, m.init || {}, { ...netOptions, allowHost: u => hosts.includes(u.hostname), ...(auth ? { auth } : {}) });
          r.body = scrub(r.body);
          for (const k of Object.keys(r.headers)) r.headers[k] = scrub(r.headers[k]);
          reply({ result: r });
        } catch (e) { reply({ error: /** @type {Error} */ (e).message }); }
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
      resolve({ items: error ? [] : items, logs, cursor: error ? null : cursor, error, ms: Date.now() - started, sandboxed: SANDBOXED, isolated: true, wall: wall.kind });
    });
    send({ t: "run", entry: pathToFileURL(path.join(real, "watch.js")).href, since: since ?? null, hook });
  });
}

/** A value and the encodings that would still identify it in a log or an item. */
function forms(v) {
  const raw = String(v);
  if (raw.length < 6) return [raw];
  return [...new Set([raw, Buffer.from(raw).toString("base64"), Buffer.from(raw).toString("base64url"), Buffer.from(raw).toString("hex"), encodeURIComponent(raw), JSON.stringify(raw).slice(1, -1)])];
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
