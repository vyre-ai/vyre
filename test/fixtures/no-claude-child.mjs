// @ts-check
// Child of test/temp-home-claude.test.js: vyred in a temp home, run the way a dev world runs it
// (not under node --test), with every fs call that names a ~/.claude path recorded and refused.
// Refused, not passed through: if Vyre reaches for the user's real ~/.claude here, it gets EACCES
// and reads nothing. Prints the paths it tried as one JSON line.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const WATCHED = [process.env.FAKE_HOME, process.env.REAL_HOME].filter(Boolean).flatMap(h => [path.join(String(h), ".claude"), path.join(String(h), ".claude.json")]);
/** @type {Set<string>} */
const touched = new Set();
const hit = (/** @type {any} */ p) => {
  if (typeof p !== "string" && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
  const s = path.resolve(p instanceof URL ? p.pathname : String(p));
  const yes = WATCHED.some(w => s === w || s.startsWith(w + path.sep));
  if (yes) touched.add(s.replace(String(process.env.REAL_HOME), "<real home>").replace(String(process.env.FAKE_HOME), "<home>"));
  return yes;
};
const denied = () => Object.assign(new Error("EACCES: a temp home never reads ~/.claude"), { code: "EACCES" });
const NAMES = ["readFileSync", "readdirSync", "statSync", "lstatSync", "openSync", "opendirSync", "realpathSync", "accessSync",
  "createReadStream", "watch", "watchFile", "writeFileSync", "appendFileSync", "mkdirSync", "copyFileSync", "cpSync", "rmSync"];
for (const n of NAMES) {
  const orig = /** @type {any} */ (fs)[n];
  if (typeof orig !== "function") continue;
  /** @type {any} */ (fs)[n] = function (/** @type {any} */ p, /** @type {any[]} */ ...rest) { if (hit(p)) throw denied(); return orig.call(this, p, ...rest); };
}
const exists = fs.existsSync;
fs.existsSync = p => (hit(p) ? false : exists(p));
for (const n of ["readFile", "readdir", "stat", "lstat", "open", "opendir", "realpath", "access", "watch", "writeFile", "appendFile", "mkdir", "cp", "rm"]) {
  const orig = /** @type {any} */ (fsp)[n];
  if (typeof orig !== "function") continue;
  /** @type {any} */ (fsp)[n] = function (/** @type {any} */ p, /** @type {any[]} */ ...rest) { if (hit(p)) return Promise.reject(denied()); return orig.call(this, p, ...rest); };
}
for (const n of ["readFile", "readdir", "stat", "lstat", "open", "access", "realpath"]) {
  const orig = /** @type {any} */ (fs)[n];
  /** @type {any} */ (fs)[n] = function (/** @type {any} */ p, /** @type {any[]} */ ...rest) {
    if (hit(p)) { const cb = rest[rest.length - 1]; if (typeof cb === "function") return process.nextTick(cb, denied()); }
    return orig.call(this, p, ...rest);
  };
}
syncBuiltinESMExports();

const { start } = await import("../../core/daemon/index.js");
const { call } = await import("../../core/daemon/client.js");
const root = String(process.env.VYRE_HOME);
const d = await start({ root, log: () => {} });
try {
  // What a fresh home does on its own and on first use: index, curate, the memory and learn views.
  for (const [tool, input] of [["recall.index", {}], ["recall.status", {}], ["recall.sessions", {}], ["memory.curate", {}],
    ["memory.facts", {}], ["settings.get", {}], ["learn.lessons", {}], ["learn.skills", {}], ["learn.stats", {}], ["sessions.models.get", {}], ["threads.list", {}], ["projects.list", {}]]) {
    await call(tool, input, { root, timeout: 20_000 }).catch(() => null);
  }
  await new Promise(r => setTimeout(r, 1500));
} finally {
  await d.stop();
}
process.stdout.write(JSON.stringify({ touched: [...touched].sort() }) + "\n");
process.exit(0);
