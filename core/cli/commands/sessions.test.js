// @ts-check
// `vyre sessions setup` as a person runs it: the real bin/vyre in a child process against a vyred
// started in this process in a temp home. The Agent SDK is laid down as a fake package in the
// temp home first, so setup finds it installed and npm never runs: nothing is downloaded.
// (sessions.setup has no seam for npm, so the install and a failed install are not driven from
// here; core/sessions tests cover install() with its npm option.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome } from "../../../test/helpers.js";
import { PACKAGE, VERSION } from "../../sessions/sdk.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

/** A fake SDK package where vyred looks for it, at the pinned version. */
function fakeSdk(root) {
  const pkg = path.join(root, "sessions-sdk", "node_modules", ...PACKAGE.split("/"));
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: PACKAGE, version: VERSION, main: "sdk.mjs" }));
  fs.writeFileSync(path.join(pkg, "sdk.mjs"), "export {};\n");
}

async function world(t, { sdk = true } = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { disable: ["recall", "memory", "learn"] }, sessions: { claude: "installed" } }));
  if (sdk) fakeSdk(root);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  return { root, vyre: (/** @type {string[]} */ ...args) => run(root, args) };
}

test("sessions cli: setup with the SDK already there says so, prints one JSON value with --json, and runs no npm", async t => {
  const { vyre } = await world(t);
  const s = await vyre("sessions", "setup");
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /installing the Claude Agent SDK/);
  assert.match(s.out, new RegExp(`installed Agent SDK ${VERSION.replace(/\./g, "\\.")}`));
  assert.match(s.out, /sessions started from now on use it once vyred restarts/);

  const j = await vyre("sessions", "setup", "--json");
  assert.equal(j.code, 0, j.out);
  assert.equal(j.out.trim().split("\n").length, 1, "one line of JSON, no progress line");
  const d = JSON.parse(j.out);
  assert.equal(d.sdk.installed, true);
  assert.equal(d.sdk.version, VERSION);

  const status = JSON.parse((await vyre("sessions", "--json")).out);
  assert.equal(status.sdk.installed, true);
});

test("sessions cli: a mistyped subcommand is a usage mistake with a next step", async t => {
  const { vyre } = await world(t, { sdk: false });
  const bad = await vyre("sessions", "setpu");
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /"setpu" is not a vyre sessions command: setup, models or prompt/);
  assert.match(bad.out, /next: vyre help sessions/);
  const st = JSON.parse((await vyre("sessions", "--json")).out);
  assert.equal(st.sdk.installed, false, "nothing was installed");
});
