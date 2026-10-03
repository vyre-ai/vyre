// kernel/modules/child.js: runs inside the sandbox. It loads the module's entry and speaks newline-delimited JSON with the supervisor over stdin and
// stdout, the only two things the sandbox lets it hold. The module has no socket: a request to the outside world is a message to the supervisor
// (`ctx.egress.fetch`), which decides. Nothing here is trusted by the kernel; it is only the module's way to be called.
import readline from "node:readline";
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

let handlers = {};
try { handlers = (await import(pathToFileURL(path.resolve(entry)).href)).handlers || {}; } catch (e) { send({ ready: false, error: String(e && /** @type {any} */ (e).message).slice(0, 200) }); process.exit(2); }
send({ ready: true, methods: Object.keys(handlers) });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.down !== undefined) { const p = pending.get(m.down); if (p) { pending.delete(m.down); m.ok ? p.res(m.result) : p.rej(Object.assign(new Error(m.error?.message || "refused"), { code: m.error?.code })); } return; }
  if (m.op === "call") {
    try { send({ id: m.id, ok: true, result: await /** @type {any} */ (handlers)[m.method]({ input: m.input, egress }) }); }
    catch (e) { send({ id: m.id, ok: false, error: { code: /** @type {any} */ (e)?.code || "failed", message: String(e && /** @type {any} */ (e).message).slice(0, 200) } }); }
  }
});
rl.on("close", () => process.exit(0));
