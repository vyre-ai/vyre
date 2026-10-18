// Build the saved database a new Space starts from (stores/twenty/provision.js findGolden): provision a scratch Space the slow way, make the core types and the base Kit in it, and save its
// database. Run once per Twenty image (and again when the core types change a lot; a Space made from an older one just makes the difference) on a machine with Docker:
//   node stores/twenty/live/build-golden.mjs [out-folder, default stores/twenty/golden]
// The folder then holds <tag>.dump and <tag>.json (what the store knows of the types, to carry into the new Space). Ship the folder with the release; the
// daemon finds it through VYRE_TWENTY_GOLDEN_DIR or stores/twenty/golden.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { provisionSpace, names, spaceDir, realRunner, TWENTY_TESTED_REF, tagOfRef, CORE_USER_TABLE, CORE_USER_PROBE } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { defineCore } from "../space-store.js";
import { TwentyClient } from "../client.js";
import { FLOW_TYPES } from "../../../kernel/flows/store.js";
import { KIT_TYPES } from "../../../kernel/flows/kits.js";
import { KIT_STORAGE_TYPES } from "../../../lib/kit-storage-types.js";
import { MEMORY_FACT } from "../../../kernel/gateway/memory.js";
import { PLANNER_TYPES } from "../../../core/planner/types.js";

const out = path.resolve(process.argv[2] ?? new URL("../golden", import.meta.url).pathname);
const image = process.env.TWENTY_IMAGE_REF || TWENTY_TESTED_REF;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-golden-"));
const space = "golden";
const n = names(space);
const t0 = Date.now();
const lap = (/** @type {string} */ s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const sh = (/** @type {string[]} */ a) => execFileSync("docker", a, { maxBuffer: 1 << 28 }).toString();
let ok = false;
try {
  const p = await provisionSpace({ home, space, reach: "ip", runner: realRunner(), image, golden: false, log: lap });
  const store = createTwentyStore({ space, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), dir: path.join(spaceDir(home, space), "state"), webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim() });
  await defineCore(store, lap);
  // The kernel's own types, made at every start (core/daemon/flows-host.js: the Flow and Kit types and the two Kit storage types; the planner's and the memory's own): put in the saved database too,
  // so a new Space starts with them and its first define finds nothing to do (each type took Twenty seconds per field, minutes in all, after Records already read as ready).
  // One at a time, and one that Twenty refuses is left to the Space to make as before: a bad extra must never stop the build.
  {
    const known = new Set((await store.types()).map((/** @type {any} */ t) => t.name));
    // the types the first-party modules declare in their manifests (needs.kernel.types: the agent, goal, preview_doc, def-watcher and file-share types), which the kernel defines when each module starts
    const coreDir = new URL("../../../core/", import.meta.url).pathname;
    const fromModules = fs.readdirSync(coreDir).sort().flatMap((/** @type {string} */ d) => {
      try { const m = JSON.parse(fs.readFileSync(path.join(coreDir, d, "module.json"), "utf8")); return Array.isArray(m?.needs?.kernel?.types) ? m.needs.kernel.types.filter((/** @type {any} */ t) => t && typeof t.name === "string") : []; } catch { return []; }
    });
    for (const t of [...FLOW_TYPES, ...KIT_TYPES, ...KIT_STORAGE_TYPES, MEMORY_FACT, ...PLANNER_TYPES, ...fromModules]) {
      if (known.has(t.name)) continue;
      known.add(t.name);
      try { await store.define({ add_types: [JSON.parse(JSON.stringify(t))] }); lap(`system type ${t.name} made`); } catch (e) { lap(`system type ${t.name} NOT made, the Space will make it: ${/** @type {Error} */ (e).message}`); }
    }
  }
  lap(`types made: ${(await store.types()).map((/** @type {any} */ t) => t.name).join(", ")}`);
  // the repair in box/vyre (sp_schema) and the helper's mark ask for this table: if a pinned Twenty ever renames it, this build fails instead of every Space reading as empty
  const hasUser = execFileSync("docker", ["exec", `${n.project}-db-1`, "psql", "-U", "postgres", "-d", "default", "-tAc", CORE_USER_PROBE]).toString().replace(/\s/g, "");
  if (!hasUser) throw new Error(`the pinned Twenty image has no ${CORE_USER_TABLE}: box/vyre's sp_schema must change with it`);
  await store.prepare();
  lap("mirror columns made");
  const sdir = path.join(spaceDir(home, space), "state");
  const state = Object.fromEntries(["types.json", "attr-mirror.json"].map((f) => [f, JSON.parse(fs.readFileSync(path.join(sdir, f), "utf8"))]));
  const db = `${n.project}-db-1`;
  sh(["exec", db, "pg_dump", "-Fc", "--no-owner", "--no-acl", "-U", "postgres", "-d", "default", "-f", "/tmp/golden.dump"]);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const tag = tagOfRef(image);
  sh(["cp", `${db}:/tmp/golden.dump`, path.join(out, `${tag}.dump`)]);
  fs.chmodSync(path.join(out, `${tag}.dump`), 0o644); // read by the unprivileged generator in the image: not a secret (no password in it)
  const admin = JSON.parse(fs.readFileSync(path.join(spaceDir(home, space), "admin.secret"), "utf8"));
  fs.writeFileSync(path.join(out, `${tag}.json`), JSON.stringify({ image, email: admin.email, workspaceId: p.workspaceId, builtAt: new Date().toISOString(), sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(out, `${tag}.dump`))).digest("hex"), state }, null, 2), { mode: 0o644 });
  lap(`saved ${path.join(out, `${tag}.dump`)} (${(fs.statSync(path.join(out, `${tag}.dump`)).size / 1e6).toFixed(1)} MB)`);
  ok = true;
} finally {
  try { execFileSync("docker", ["compose", "-p", n.project, "down", "-v"], { stdio: "ignore" }); } catch { /* gone already */ }
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
