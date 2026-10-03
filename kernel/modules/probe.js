// kernel/modules/probe.js: runs under the sandbox command in the supervisor's self-test and reports what it could do. Every attempt must fail.
// argv: the loopback port of a listener the supervisor holds, and a file outside the module's folder that the sandbox must hide.
import net from "node:net";
import fs from "node:fs";
import cp from "node:child_process";

const [port, secret] = process.argv.slice(2);
const out = {};
const attempt = async (/** @type {string} */ name, /** @type {() => any} */ f) => { try { await f(); out[name] = "allowed"; } catch { out[name] = "blocked"; } };
await attempt("network", () => new Promise((res, rej) => { const s = net.connect({ host: "127.0.0.1", port: Number(port) }, () => { s.destroy(); res(true); }); s.on("error", rej); setTimeout(() => rej(new Error("timeout")), 1500); }));
await attempt("write_module", () => fs.writeFileSync("/module/probe-wrote", "x"));
await attempt("read_outside", () => fs.readFileSync(secret, "utf8"));
await attempt("child_process", () => cp.spawnSync("/bin/true"));
await attempt("worker", async () => { const { Worker } = await import("node:worker_threads"); new Worker("1", { eval: true }); });
process.stdout.write(JSON.stringify(out) + "\n");
