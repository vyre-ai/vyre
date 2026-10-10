#!/usr/bin/env node
// scripts/proof-install.mjs: the install and pairing walk, end to end, printing one line per step (PASS, FAIL with the reason, or SKIP when an earlier step it needs failed).
//
//   node scripts/proof-install.mjs [--server daemon|installer|mac] [--store records|plain|both] [--out DIR] [--live-relay]
//   --update (with --server installer) installs the OLD release (v0.2.11), pairs the app, and updates it to this checkout from the app (update.apply); see walk.mjs updateSteps
//   node scripts/proof-install.mjs --live --host <ssh host> [--expect-version X.Y.Z] [--out DIR]   the real walk: names.vyre.run, relay.vyre.run and a real server over ssh (scripts/lib/proof/live.mjs)
//   --live-relay uses the real wss://relay.vyre.run as transport only (a live service can run older code than the repo); names stay on the stand-in
//
// Everything is real except the person's clicks and the places a person would not reach from here: the names directory (the Worker's own code on the fake runtime) and the relay
// (the real relay), both local; nothing touches vyre.run, names.vyre.run or relay.vyre.run. The app side is scripts/lib/proof/app.mjs, which imports the app's own modules.
// Where the server comes from (--server):
//   daemon     a real vyred in this process on a fresh home, started as the installer leaves a server (a test box, where a second docker stack must not start)
//   installer  scripts/install-box.sh against a locally built site, with docker (a CI runner only: it uses the fixed /srv/vyre and container names)
//   mac        scripts/install-mac-server.sh on a hosted macOS runner (CI only)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun } from "./lib/proof/run.mjs";
import { startStandins } from "./lib/proof/standins.mjs";
import { walk, walkTerminal, walkUpdate } from "./lib/proof/walk.mjs";
import { buildUpdateReleases } from "./lib/proof/update-releases.mjs";

const argv = process.argv.slice(2);
const take = (/** @type {string} */ f, /** @type {string} */ d = "") => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const live = argv.includes("--live");
const server = /** @type {"daemon" | "installer" | "mac"} */ (take("--server", "daemon"));
const liveRelay = argv.includes("--live-relay") ? "wss://relay.vyre.run" : "";
const storeArg = take("--store", "both");
const out = path.resolve(take("--out", path.join(os.tmpdir(), `proof-install-${process.pid}`)));
if (!["daemon", "installer", "mac"].includes(server)) { console.error("proof-install: --server is daemon, installer or mac"); process.exit(64); }
if (!["records", "plain", "both"].includes(storeArg)) { console.error("proof-install: --store is records, plain or both"); process.exit(64); }
const updateProof = argv.includes("--update");
if (updateProof && server !== "installer") { console.error("proof-install: --update needs --server installer"); process.exit(64); }
const stores = /** @type {("records" | "plain")[]} */ (updateProof ? ["plain"] : storeArg === "both" ? ["records", "plain"] : [storeArg]);

let code = 1;
const run = createRun({ out });
if (live) {
  // Everything real: no stand-ins, no server of this checkout. Never run this on a machine that holds a Vyre of its own to protect: it only drives an app and ssh, but run it on a test box.
  const host = take("--host");
  if (!host) { console.error("proof-install: --live needs --host <ssh host> (the server it installs on and wipes)"); process.exit(64); }
  const { walkLive } = await import("./lib/proof/live.mjs");
  try { await walkLive({ run, host, out, expectVersion: take("--expect-version", ""), channel: take("--channel", "") }); } finally { code = run.finish(); }
  process.exit(code);
}
const inCI = process.env.GITHUB_ACTIONS === "true";
// A server in a container reaches the stand-ins on the runner's own address (the way scripts/matrix/j1.sh does); a daemon in this process and a Mac server reach them on loopback.
const hostIp = process.env.PROOF_HOST_IP || Object.values(os.networkInterfaces()).flat().find(n => n && n.family === "IPv4" && !n.internal)?.address || "127.0.0.1";
const ins = await startStandins({ out, ...(liveRelay ? { liveRelay } : {}), ...(server === "installer" ? { host: "0.0.0.0", publicHost: hostIp } : {}) });
try {
  /** @type {any} */ let update = null;
  if (updateProof) {
    await run.step("update: the old release and the candidate are built and served (one throwaway key)", async () => {
      update = await buildUpdateReleases({ work: path.join(process.env.RUNNER_TEMP || os.tmpdir(), "update-proof-releases"), oldTag: take("--old-tag", "v0.2.12"), candidateTag: take("--candidate-tag", ""), log: path.join(out, "build-releases.log") });
      return `${update.oldVersion} -> ${update.newVersion}`;
    });
  }
  if (update) await walkUpdate({ run, ins, out, update });
  if (!updateProof) { for (const store of stores) await walk({ run, ins, server, store, out, inCI }); await walkTerminal({ run, ins, server, out }); }
  if (update) await update.stop();
} finally {
  code = run.finish();
  await ins.stop();
}
process.exit(code);
