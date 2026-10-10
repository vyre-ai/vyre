#!/usr/bin/env node
// scripts/journeys/run.mjs: the golden journeys (team/0.3.1/JOURNEYS.md), end to end on a real server, through the tools a person and an agent use.
//
//   node scripts/journeys/run.mjs <J1|J2|...|all> [--out DIR] [--world box|daemon]
//
// A journey with world "own" (J8) builds its own servers. --world overrides a journey's own choice (J1 needs daemon for invites: a box takes the owner's yes only from a hardware key). One line per step; a FAIL names the owning team; the exit code is 1 on
// any FAIL. The world is built once per kind and shared by the journeys that use it, so a later journey sees what an earlier one made (J8, the update, goes last). Never run this on a person's
// machine: `box` needs docker and the fixed /srv/vyre stack, so it runs only on a CI runner or with VYRE_JOURNEY_BOX=1 on a test box that has nothing of its own there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun } from "../lib/proof/run.mjs";
import { bringUp } from "./lib/world.mjs";
import { stepper } from "./lib/journey.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const take = (/** @type {string} */ f, /** @type {string} */ d = "") => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const want = argv.find(a => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--out" && argv[argv.indexOf(a) - 1] !== "--world") || "";
if (!want) { console.error("usage: node scripts/journeys/run.mjs <J1|J2|...|all> [--out DIR] [--world box|daemon]"); process.exit(64); }
const out = path.resolve(take("--out", path.join(os.tmpdir(), `journeys-${process.pid}`)));
const forced = take("--world");
if (forced && !["box", "daemon"].includes(forced)) { console.error("journeys: --world is box or daemon"); process.exit(64); }

const files = fs.readdirSync(HERE).filter(f => /^j\d+\.mjs$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
/** @type {any[]} */ const journeys = [];
for (const f of files) journeys.push((await import(path.join(HERE, f))).default);
const chosen = want === "all" ? journeys : journeys.filter(j => j.id.toLowerCase() === want.toLowerCase());
if (!chosen.length) { console.error(`journeys: no journey named ${want} (have ${journeys.map(j => j.id).join(", ")})`); process.exit(64); }

const run = createRun({ out });
/** @type {Map<string, any>} */ const worlds = new Map();
let code = 1;
try {
  for (const j of chosen) {
    if (j.world === "own") {
      // a journey that builds its own servers (J8 installs the previous release, then updates it): it gets the reporter and a folder, nothing shared
      await j.steps({ run, out, J: stepper(run, j) }, stepper(run, j));
      continue;
    }
    const kind = forced || j.world;
    const key = `${kind}/${j.store}`;
    if (!worlds.has(key)) worlds.set(key, await bringUp({ run, out, kind, store: j.store }));
    const w = worlds.get(key);
    const J = stepper(run, j);
    if (!w.ready) { await run.step(J.name("the world is up"), () => { throw new Error(`the ${kind} world did not come up; see the lines above (owner: release)`); }); continue; }
    await j.steps(w, J);
  }
} finally {
  for (const w of worlds.values()) await w.stop().catch(() => {});
  code = run.finish();
}
process.exit(code);
