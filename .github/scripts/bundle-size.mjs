// bundle-size: the web app's JavaScript budget, measured on the exported dist. TEST BOX AND CI ONLY.
//   node .github/scripts/bundle-size.mjs --dist apps/app/dist --out size.json [--base <the last green run's size.json>]
// The budget measures what a person waits for, so the ceiling is on the FIRST LOAD (the scripts index.html names: the runtime, the shared chunk and the entry), gzip -9, 1100 KiB, hard. Every lazy chunk
// (a route or a library that loads when its screen is opened) stays under 300 KiB. The TOTAL of every .js in dist (lazy chunks and the terminal's vendored files included) is reported, not ceilinged:
// splitting a bundle does not make the app smaller, and a ceiling on the total only punishes splitting. Drift still fails: either number growing more than 10% against the last green run fails the job.
// A baseline recorded before this rule has no first_load_kib and measured the total another way, so neither 10% rule waits for the first green run that records both.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const flag = (n, d = "") => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const dist = path.resolve(flag("--dist", "apps/app/dist")), out = flag("--out", "size.json"), baseFile = flag("--base");
export const FIRST_LOAD_CEILING_KIB = 1100, CHUNK_CEILING_KIB = 300, DRIFT = 1.1;

const gz = (/** @type {string} */ f) => zlib.gzipSync(fs.readFileSync(f), { level: 9 }).length;
const walk = (/** @type {string} */ d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const all = walk(dist).filter((f) => f.endsWith(".js"));
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const first = new Set([...html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"/g)].map((m) => path.join(dist, m[1].replace(/^\/app\//, "").replace(/^\//, ""))));
const kib = (/** @type {number} */ b) => Math.round(b / 1024);

const sizes = all.map((f) => ({ f: path.relative(dist, f), b: gz(f), first: first.has(f) }));
const firstKib = kib(sizes.filter((s) => s.first).reduce((n, s) => n + s.b, 0));
const totalKib = kib(sizes.reduce((n, s) => n + s.b, 0));
const lazy = sizes.filter((s) => !s.first).sort((a, b) => b.b - a.b);
fs.writeFileSync(out, JSON.stringify({ js_gzip_kib: totalKib, first_load_kib: firstKib }) + "\n");

const lines = [`web JS gzipped: first load ${firstKib} KiB (ceiling ${FIRST_LOAD_CEILING_KIB}), total ${totalKib} KiB (reported)`, `largest lazy chunks: ${lazy.slice(0, 5).map((s) => `${s.f.split("/").pop()} ${kib(s.b)} KiB`).join(", ")}`];
let base = null;
try { base = baseFile ? JSON.parse(fs.readFileSync(baseFile, "utf8")) : null; } catch { base = null; }
const fails = [];
if (firstKib > FIRST_LOAD_CEILING_KIB) fails.push(`first-load JS is over the ${FIRST_LOAD_CEILING_KIB} KiB ceiling`);
for (const s of lazy) if (kib(s.b) > CHUNK_CEILING_KIB) fails.push(`lazy chunk ${s.f} is ${kib(s.b)} KiB, over ${CHUNK_CEILING_KIB}`);
if (base && Number.isFinite(base.first_load_kib) && Number.isFinite(base.js_gzip_kib)) {
  lines.push(`last green: first load ${base.first_load_kib} KiB, total ${base.js_gzip_kib} KiB`);
  if (firstKib > base.first_load_kib * DRIFT) fails.push("first-load JS grew more than 10%");
  if (totalKib > base.js_gzip_kib * DRIFT) fails.push("total JS grew more than 10%");
} else lines.push("no baseline that records both numbers yet: the 10% rules wait for the first green run that does");
console.log(lines.join("\n"));
if (fails.length) { console.log(fails.map((f) => `FAIL ${f}`).join("\n")); process.exit(1); }
