// Build the saved database a new Space starts from (stores/twenty/provision.js findGolden): provision a scratch Space the slow way, make the core types and the base Kit in it, and save its
// database. Run once per Twenty image (and again when the core types change a lot; a Space made from an older one just makes the difference) on a machine with Docker:
//   node stores/twenty/live/build-golden.mjs [out-folder, default stores/twenty/golden]
// The folder then holds <tag>.dump and <tag>.json (what the store knows of the types, to carry into the new Space). Ship the folder with the release; the
// daemon finds it through VYRE_TWENTY_GOLDEN_DIR or stores/twenty/golden.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { provisionSpace, names, spaceDir, realRunner, TWENTY_TESTED_REF, tagOfRef } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { defineCore } from "../space-store.js";
import { TwentyClient } from "../client.js";

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
  lap(`types made: ${(await store.types()).map((/** @type {any} */ t) => t.name).join(", ")}`);
  await store.prepare();
  lap("mirror columns made");
  const sdir = path.join(spaceDir(home, space), "state");
  const state = Object.fromEntries(["types.json", "attr-mirror.json"].map((f) => [f, JSON.parse(fs.readFileSync(path.join(sdir, f), "utf8"))]));
  const db = `${n.project}-db-1`;
  sh(["exec", db, "pg_dump", "-Fc", "--no-owner", "--no-acl", "-U", "postgres", "-d", "default", "-f", "/tmp/golden.dump"]);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const tag = tagOfRef(image);
  sh(["cp", `${db}:/tmp/golden.dump`, path.join(out, `${tag}.dump`)]);
  fs.chmodSync(path.join(out, `${tag}.dump`), 0o600);
  const admin = JSON.parse(fs.readFileSync(path.join(spaceDir(home, space), "admin.secret"), "utf8"));
  fs.writeFileSync(path.join(out, `${tag}.json`), JSON.stringify({ image, email: admin.email, password: admin.password, workspaceId: p.workspaceId, builtAt: new Date().toISOString(), state }, null, 2), { mode: 0o600 });
  lap(`saved ${path.join(out, `${tag}.dump`)} (${(fs.statSync(path.join(out, `${tag}.dump`)).size / 1e6).toFixed(1)} MB)`);
  ok = true;
} finally {
  try { execFileSync("docker", ["compose", "-p", n.project, "down", "-v"], { stdio: "ignore" }); } catch { /* gone already */ }
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
