// @ts-check
// hands-bench: how fast the Mac hands are, on the real accessibility helper, against a window the bench owns (testwin) and
// nothing else. observe (the whole tree), find (a filtered read), act with its own verify (press, type) and the helper's
// per-call time. Meant for a throwaway CI runner or the vyretest account, never a person's desktop: it opens a small
// window and needs the Accessibility grant. Prints one JSON object and writes it to --out.
//
//   node local/hands-mac/bench/hands-bench.mjs [--iters 30] [--out file]

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Hands } from "../hands.js";
import { makeRunner } from "../runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AX = path.join(HERE, "..", "bin", "ax");
const TESTWIN = path.join(HERE, "..", "..", "screen-mac", "bin", "testwin");
const args = process.argv.slice(2);
const flag = (/** @type {string} */ n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const iters = Number(flag("iters")) || 30;
const out = flag("out");
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** @param {number[]} xs */
const stats = xs => { const s = [...xs].sort((a, b) => a - b); const q = (/** @type {number} */ p) => +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(1); return { n: s.length, min: q(0), p50: q(0.5), p95: q(0.95), max: q(1), mean: +(s.reduce((a, b) => a + b, 0) / (s.length || 1)).toFixed(1) }; };

/** @type {Record<string, any>} */
const result = { tool: "hands-bench", os: `${process.platform}-${process.arch}`, node: process.version, at: new Date().toISOString(), iters };
const finish = (/** @type {number} */ code) => {
  console.log(JSON.stringify(result, null, 2));
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2)); }
  process.exit(code);
};

if (process.platform !== "darwin") { result.skipped = "not macOS"; finish(0); }
for (const b of [AX, TESTWIN]) if (!fs.existsSync(b)) { result.skipped = `${path.basename(b)} is not built`; finish(0); }

const ax = makeRunner({ bin: AX });
try { result.trusted = (await ax({ cmd: "trust" })).trusted === true; } catch (e) { result.trusted = false; result.helperError = String(/** @type {Error} */ (e).message).slice(0, 200); }
if (!result.trusted) { result.skipped = "no Accessibility grant for the helper"; finish(0); }

const title = `Vyre hands bench ${process.pid}`;
const tw = spawn(TESTWIN, ["--title", title, "--x", "40", "--y", "80", "--w", "520", "--h", "360"], { stdio: ["pipe", "pipe", "ignore"] });
const cleanup = () => { try { tw.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { tw.kill("SIGKILL"); } catch { /* gone */ } }, 500).unref(); };
process.on("exit", cleanup);
const info = await new Promise((ok, no) => { tw.stdout.once("data", d => { try { ok(JSON.parse(String(d).split("\n")[0])); } catch (e) { no(e); } }); tw.once("exit", () => no(new Error("testwin exited"))); }).catch(e => { result.skipped = "testwin: " + String(e.message); return null; });
if (!info) finish(0);
const pid = /** @type {any} */ (info).pid;

/** @type {number[]} */ const axCalls = [];
const run = async (/** @type {any} */ req) => { const t0 = performance.now(); try { return await ax(req); } finally { axCalls.push(performance.now() - t0); } };
const noOverlay = { controlling: async () => {}, ring: () => {}, done: () => {}, close: () => {}, onStop: () => () => {} };
const hands = new Hands({ run, overlay: /** @type {any} */ (noOverlay), emit: () => {}, sleep, known: async () => ({ box: null }) });

let seen;
for (let i = 0; i < 40; i++) { try { seen = await hands.observe({ pid }); if (seen.elements.some((/** @type {any} */ e) => e.selector.name === "Press me")) break; } catch { /* not there yet */ } await sleep(150); }
if (!seen || !seen.elements.some((/** @type {any} */ e) => e.selector.name === "Press me")) { result.skipped = "testwin never showed its controls in the accessibility tree"; finish(0); }
result.controls = seen.elements.length;

const time = async (/** @type {number} */ n, /** @type {() => Promise<any>} */ fn) => { const xs = []; for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); xs.push(performance.now() - t); } return stats(xs); };
axCalls.length = 0;
result.observe = await time(iters, () => hands.observe({ pid }));
result.find = await time(iters, () => hands.observe({ pid, match: { role: "AXButton", name: "Press me" } }));
/** @type {string[]} */ const unverified = [];
result.act_press_verified = await time(iters, async () => { const r = await hands.act({ pid, selector: { role: "AXButton", name: "Press me" }, kind: "press" }); if (!r.verified) unverified.push(String(r.reason || "not verified").slice(0, 80)); });
let n = 0;
result.act_type_verified = await time(Math.max(5, Math.floor(iters / 3)), async () => { const r = await hands.act({ pid, selector: { role: "AXTextField", name: "Name" }, kind: "type", value: `Northwind ${++n}` }); if (!r.verified) unverified.push(String(r.reason || "not verified").slice(0, 80)); });
result.unverifiedActs = unverified.length;
if (unverified.length) result.unverifiedSample = unverified.slice(0, 3);
result.axHelperPerCallMs = stats(axCalls);
finish(unverified.length ? 1 : 0);
