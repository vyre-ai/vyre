// @ts-check
// runner — the child side of one watcher run. vyred forks this file per run, under Node's
// permission model where the Node version has it, so a watcher can read only its own folder,
// write nothing, start no processes and see no environment.
//
// Everything a watcher can do goes through the four things it is handed, and each is a message
// to the parent: vault.fetch asks (the parent checks the watcher's own `needs`), emit and log
// report. The parent validates, dedupes and files; this side only runs the function.

let asked = 0;
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
const waiting = new Map();

const send = msg => new Promise(resolve => process.send?.(msg, () => resolve(undefined)));
const text = a => a.map(x => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ");

// console.* from a watcher is its log, not vyred's stdout.
for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => { send({ t: "log", line: text(a) }); };

process.on("message", async (/** @type {any} */ msg) => {
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
      fetch: name => new Promise((resolve, reject) => {
        const id = ++asked;
        waiting.set(id, { resolve, reject });
        send({ t: "vault", id, name: String(name) });
      }),
    };
    const emit = item => { send({ t: "emit", item }); };
    const log = (...a) => { send({ t: "log", line: text(a) }); };
    const cursor = await watch({ vault, since: msg.since ?? null, emit, log, hook: msg.hook ?? null });
    await send({ t: "done", cursor: cursor === undefined ? null : cursor });
  } catch (e) {
    const err = /** @type {Error} */ (e);
    await send({ t: "error", message: String(err && err.message || err) });
  }
  process.exit(0);
});
