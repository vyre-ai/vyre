// kernel/modules/child.js: runs inside the sandbox. It loads the module's entry and speaks newline-delimited JSON with the supervisor over stdin and
// stdout, the only two things the sandbox lets it hold. The module has no socket: a request to the outside world is a message to the supervisor
// (`ctx.egress.fetch`), which decides. Nothing here is trusted by the kernel; it is only the module's way to be called.
import readline from "node:readline";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const entry = process.env.VYRE_MODULE_ENTRY || process.argv[2];
let seq = 0;
/** @type {Map<number, { res: (v: any) => void, rej: (e: any) => void }>} */ const pending = new Map();
const send = (/** @type {any} */ m) => process.stdout.write(JSON.stringify(m) + "\n");
const egress = Object.freeze({
  /** @param {string} url @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init] */
  fetch: (url, init = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); send({ up: id, op: "egress", url, init }); }),
});

/** What the SDK's `ctx` is in here: the module's own ctx lives in the host (every declaration is checked there: needs.tools, needs.network, watches, teaches ...), and each door is a message to it over this pipe. Only JSON crosses. */
const door = (/** @type {string[]} */ at) => new Proxy(function () {}, {
  get: (_t, k) => (typeof k === "string" && k !== "then" ? door([...at, k]) : undefined),
  apply: (_t, _this, args) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); send({ up: id, op: "ctx", path: at, args }); }),
});
/** @type {Record<string, (a: { input: any, meta?: any, egress?: any }) => any>} */
let handlers = {};
/** @type {Map<number, (e: any) => any>} event listeners the module asked for (ctx.events.on), called when the host pushes one */
const listeners = new Map();
let identity = { name: "", version: "" };
// Listen first: a module that asks a door while it starts (a migration, a call) must get its answer before `start` returns.
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.down !== undefined) { const p = pending.get(m.down); if (p) { pending.delete(m.down); m.ok ? p.res(m.result) : p.rej(Object.assign(new Error(m.error?.message || "refused"), { code: m.error?.code })); } return; }
  if (m.ev !== undefined) { const fn = listeners.get(m.ev); if (fn) { try { await fn(m.event); } catch { /* a listener that throws stops nothing */ } } return; }
  if (m.op === "call") {
    try { send({ id: m.id, ok: true, result: await /** @type {any} */ (handlers)[m.method]({ input: m.input, meta: m.meta, egress }) }); }
    catch (e) { send({ id: m.id, ok: false, error: { code: /** @type {any} */ (e)?.code || "failed", message: String(e && /** @type {any} */ (e).message).slice(0, 200) } }); }
  }
});
rl.on("close", () => process.exit(0));
try {
  const mod = await import(pathToFileURL(path.resolve(entry)).href);
  if (mod.handlers) handlers = mod.handlers;
  else if (mod.default && typeof mod.default.start === "function") {
    // The SDK's own shape (`export default { start(ctx) }`): the same module source the built-in host runs. Its tools register here; the host already knows their names from the manifest.
    try { const j = JSON.parse(readFileSync(path.join(path.dirname(path.resolve(entry)), "module.json"), "utf8")); identity = { name: String(j.name || ""), version: String(j.version || "") }; } catch { /* no manifest to read: an empty identity */ }
    const base = door([]);
    const ctx = new Proxy({}, {
      get: (_t, k) => {
        if (k === "tool") return (/** @type {string} */ name, /** @type {any} */ def) => { handlers[name] = ({ input, meta }) => def.run(input, meta || {}); };
        if (k === "name") return identity.name;
        if (k === "version") return identity.version;
        if (k === "api") return { version: 1, has: () => false };
        if (k === "log") return Object.fromEntries(["debug", "info", "warn", "error"].map(l => [l, (/** @type {string} */ msg, /** @type {any} */ extra) => { send({ log: l, msg: String(msg).slice(0, 500), ...(extra === undefined ? {} : { extra: JSON.stringify(extra).slice(0, 500) }) }); }]));
        if (k === "events") return new Proxy({}, { get: (_e, m) => m === "on"
          ? (/** @type {string} */ pattern, /** @type {(e: any) => any} */ fn) => { const id = ++seq; listeners.set(id, fn); return /** @type {any} */ (base).events.subscribe(pattern, id).then(() => () => listeners.delete(id)); }
          : /** @type {any} */ (base).events[/** @type {string} */ (m)] });
        if (k === "store") return new Proxy({}, { get: (_e, m) => (m === "db" ? undefined : /** @type {any} */ (base).store[/** @type {string} */ (m)]) });
        return /** @type {any} */ (base)[/** @type {string} */ (k)];
      },
    });
    await mod.default.start(ctx);
  }
} catch (e) { send({ ready: false, error: String(e && /** @type {any} */ (e).message).slice(0, 200) }); process.exit(2); }
send({ ready: true, methods: Object.keys(handlers) });

