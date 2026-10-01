// @ts-check
// runner: the child side of one watcher run. vyred forks this file per run, under Node's
// permission model where the Node version has it, so a watcher can read only its own folder,
// write nothing, start no processes and see no environment.
//
// Everything a watcher can do goes through the things it is handed (and `fetch`, which is the parent's), and each is a message
// to the parent: vault.fetch asks (the parent checks the watcher's own `needs`), emit and log
// report. The parent validates, dedupes and files; this side only runs the function.

let asked = 0;
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
const waiting = new Map();

// Lines of JSON to the parent on stdout, and from it on stdin: that channel carries messages and
// nothing else. Whatever the watcher prints (console, log(), stray writes) goes to stderr, which
// the parent reads as the watcher's log.
const writeOut = process.stdout.write.bind(process.stdout);
const writeErr = process.stderr.write.bind(process.stderr);
const send = msg => new Promise(resolve => { writeOut(JSON.stringify(msg) + "\n", () => resolve(undefined)); });
const toLog = line => { writeErr(String(line) + "\n"); };
const text = a => a.map(x => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ");

// console.* from a watcher is its log, not vyred's stdout.
for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => { toLog(text(a)); };

// The child has no network of its own. fetch(url, { method?, headers? }) asks the parent, which
// resolves the name, refuses non-public addresses and runs a GET or HEAD. It answers a small
// Response-like object: ok, status, url, headers, text(), json().
let fetched = 0;
const hostFetch = (url, init = {}) => new Promise((resolve, reject) => {
  const id = ++fetched;
  waiting.set(id, { resolve, reject });
  send({ t: "fetch", id, url: String(url && url.href || url), init: { method: init.method, headers: init.headers } });
});
const wrap = r => ({ ok: r.status >= 200 && r.status < 300, status: r.status, url: r.url, truncated: r.truncated, headers: { get: k => r.headers[String(k).toLowerCase()] ?? null },
  text: async () => r.body, json: async () => JSON.parse(r.body) });
globalThis.fetch = async (url, init) => wrap(await hostFetch(url, init));

// ask(prompt) is a judgment from a model, no tools, answered as text. Treat fetched content in a
// prompt as data: the reply is advice to your own code, never an instruction to follow blindly.
const ask = prompt => new Promise((resolve, reject) => {
  const id = ++fetched;
  waiting.set(id, { resolve, reject });
  send({ t: "ask", id, prompt: String(prompt) });
});

process.stdout.write = chunk => { String(chunk).split("\n").filter(Boolean).forEach(toLog); return true; };
process.stderr.write = chunk => { String(chunk).split("\n").filter(Boolean).forEach(l => writeErr(l + "\n")); return true; };

const onMessage = async (/** @type {any} */ msg) => {
  if (msg.t === "ask") {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (w) msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.text);
    return;
  }
  if (msg.t === "fetch") {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (w) msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result);
    return;
  }
  if (msg.t === "vault") {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (w) msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.value);
    return;
  }
  if (msg.t !== "run") return;
  try {
    const mod = await import(msg.entry);
    const watch = mod.default;
    if (typeof watch !== "function") throw new Error("watch.js has no default export function");
    const vault = {
      fetch: (name, { field } = {}) => new Promise((resolve, reject) => {
        const id = ++asked;
        waiting.set(id, { resolve, reject });
        send({ t: "vault", id, name: String(name), ...(field ? { field: String(field) } : {}) });
      }),
    };
    const emit = item => { send({ t: "emit", item }); };
    const log = (...a) => { toLog(text(a)); };
    const cursor = await watch({ vault, since: msg.since ?? null, emit, log, hook: msg.hook ?? null, ask });
    await send({ t: "done", cursor: cursor === undefined ? null : cursor });
  } catch (e) {
    const err = /** @type {Error} */ (e);
    await send({ t: "error", message: String(err && err.message || err) });
  }
  process.exit(0);
};

let inbox = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  inbox += chunk;
  for (let i = inbox.indexOf("\n"); i >= 0; i = inbox.indexOf("\n")) {
    const one = inbox.slice(0, i); inbox = inbox.slice(i + 1);
    let m; try { m = JSON.parse(one); } catch { continue; }
    onMessage(m);
  }
});
