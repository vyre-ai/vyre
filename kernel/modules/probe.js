// kernel/modules/probe.js: runs under the sandbox command in the supervisor's self-test and reports what it could do. Every attempt must fail.
// argv: the loopback port of a listener the supervisor holds, and a file outside the module's folder that the sandbox must hide.
import net from "node:net";
import fs from "node:fs";
import cp from "node:child_process";

const [port, secret, sibling] = process.argv.slice(2);
const out = {};
const attempt = async (/** @type {string} */ name, /** @type {() => any} */ f) => { try { await f(); out[name] = "allowed"; } catch { out[name] = "blocked"; } };
await attempt("network", () => new Promise((res, rej) => { const s = net.connect({ host: "127.0.0.1", port: Number(port) }, () => { s.destroy(); res(true); }); s.on("error", rej); setTimeout(() => rej(new Error("timeout")), 1500); }));
await attempt("write_module", () => fs.writeFileSync("/module/probe-wrote", "x"));
await attempt("read_outside", () => fs.readFileSync(secret, "utf8"));
await attempt("child_process", () => cp.spawnSync("/bin/true"));
await attempt("worker", async () => { const { Worker } = await import("node:worker_threads"); new Worker("1", { eval: true }); });
await attempt("read_passwd", () => fs.readFileSync("/etc/passwd", "utf8"));
await attempt("read_environ", () => fs.readFileSync("/proc/self/environ", "utf8"));
await attempt("proc_listing", () => { const l = fs.readdirSync("/proc").filter(x => /^\d+$/.test(x) && Number(x) !== process.pid); if (!l.length) throw new Error("nothing else visible"); });
await attempt("root_listing", () => { const l = fs.readdirSync("/").filter(x => !["module", "vyre", "usr", "lib", "lib64", "bin", "proc", "dev", "tmp", "sbin"].includes(x)); if (!l.length) throw new Error("nothing beyond the bare view"); });
await attempt("signal_other", () => process.kill(Number(sibling), 0));
await attempt("dns", async () => { const dns = await import("node:dns/promises"); await Promise.race([dns.lookup("example.com"), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 2000))]); });
await attempt("dlopen", () => process.dlopen({ exports: {} }, "/usr/lib/x86_64-linux-gnu/libc.so.6"));
await attempt("env_extra", () => { const extra = Object.keys(process.env).filter(k => !["PATH", "VYRE_MODULE_ENTRY", "PWD"].includes(k)); if (!extra.length) throw new Error("clean"); });
process.stdout.write(JSON.stringify(out) + "\n");
