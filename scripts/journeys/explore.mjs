#!/usr/bin/env node
// scripts/journeys/explore.mjs <snippet.mjs> [--world daemon|box] [--store records|plain]: bring the journeys' world up, then run a snippet in it; for writing a journey step against the real tools.
// The snippet is an ES module whose default export is `async (w) => ...` (w is the world of lib/world.mjs); its return value is printed as JSON. Test boxes only.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRun } from "../lib/proof/run.mjs";
import { bringUp } from "./lib/world.mjs";

const argv = process.argv.slice(2);
const take = (/** @type {string} */ f, /** @type {string} */ d = "") => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const file = argv.find(a => !a.startsWith("--") && ![take("--world"), take("--store"), take("--out")].includes(a));
if (!file) { console.error("usage: node scripts/journeys/explore.mjs <snippet.mjs> [--world daemon|box] [--store records|plain]"); process.exit(64); }
const out = path.resolve(take("--out", path.join(os.tmpdir(), `explore-${process.pid}`)));
const run = createRun({ out, say: () => {} });
const w = await bringUp({ run, out, kind: /** @type {any} */ (take("--world", "daemon")), store: /** @type {any} */ (take("--store", "plain")) });
let code = 0;
try {
  if (!w.ready) throw new Error(`the world did not come up: ${run.results.filter(r => r.ok === false).map(r => r.name + ": " + r.why).join(" | ")}`);
  const f = (await import(pathToFileURL(path.resolve(file)).href)).default;
  console.log(JSON.stringify(await f(w), null, 2));
} catch (e) { console.error(String(/** @type {Error} */ (e).stack || e)); code = 1; } finally { await w.stop().catch(() => {}); }
process.exit(code);
