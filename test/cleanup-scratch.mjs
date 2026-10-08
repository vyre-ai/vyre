// @ts-check
// Loaded into every test process by the test runner (scripts/test-counts.mjs, --import): every temp folder this process makes with mkdtemp under the
// system temp folder (SCRATCH included) is removed when the process exits, with the `<dir>.sessions` folder a test daemon keeps beside its home. A test
// should still clean up after itself (t.after); this is the floor under it, so a daemon that writes into a home after the test removed it, or a test that
// forgot, never leaves a folder for test/tmp-guard.mjs to find. Exit is the one moment nothing of this process can still be writing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const roots = [path.resolve(os.tmpdir())];
try { roots.push(fs.realpathSync(os.tmpdir())); } catch { /* the same folder */ }
/** @type {Set<string>} */
const made = new Set();
const under = (/** @type {string} */ p) => { const r = path.resolve(p); return roots.some(t => r.startsWith(t + path.sep)); };
const keep = (/** @type {any} */ p) => { if (typeof p === "string" && under(p)) made.add(path.resolve(p)); return p; };

const sync = fs.mkdtempSync;
// @ts-ignore: the same signature, wrapped
fs.mkdtempSync = function (...a) { return keep(sync.apply(fs, /** @type {any} */ (a))); };
const prom = fs.promises.mkdtemp;
// @ts-ignore: the same signature, wrapped
fs.promises.mkdtemp = async function (...a) { return keep(await prom.apply(fs.promises, /** @type {any} */ (a))); };

process.on("exit", () => {
  for (const d of made) for (const p of [d, `${d}.sessions`]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone, or busy: the guard says so */ } }
});
