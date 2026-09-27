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

/** @returns {Promise<{ code: number, out: string, stdout: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr, stdout })));

/** Every stdout line of a --view run, parsed as a frame. @param {string} s */
const frames = s => s.trim().split("\n").map(l => JSON.parse(l));

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
  assert.match(bad.out, /"setpu" is not a vyre sessions command: status, setup, models or prompt/);
  assert.match(bad.out, /next: vyre help sessions/);
  const st = JSON.parse((await vyre("sessions", "--json")).out);
  assert.equal(st.sdk.installed, false, "nothing was installed");
});

test("sessions cli: vyre commands lists every verb run() handles, without vyred", async t => {
  const root = tempHome(t);
  const r = await run(root, ["commands", "sessions", "--json"]);
  assert.equal(r.code, 0, r.out);
  const verbs = JSON.parse(r.stdout).commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["status", "setup", "models", "prompt"]);
  assert.deepEqual(verbs.filter(v => v.read).map(v => v.verb), ["status"], "models and prompt can change things");
  assert.deepEqual(verbs.find(v => v.verb === "prompt").flags.map(f => f.name), ["text", "file", "replace", "note"]);
  assert.deepEqual(verbs.find(v => v.verb === "models").args.map(a => [a.name, a.required]), [["scope", false], ["model", false]]);
});

test("sessions cli: --view draws status as a card, models as a table, and asks for a prompt's text instead of opening an editor", async t => {
  const { vyre } = await world(t);
  const s = await vyre("sessions", "status", "--view");
  assert.equal(s.code, 0, s.out);
  const f = frames(s.stdout);
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.title, f[0].view.state], ["sessions status", "card", "Sessions", "ok"]);
  assert.ok(f[0].view.fields.some(x => x.label === "Agent SDK" && /installed/.test(x.value)));
  assert.deepEqual(f[0].data, JSON.parse((await vyre("sessions", "--json")).stdout), "data is what --json prints");
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 0 });

  const m = frames((await vyre("sessions", "models", "--view")).stdout);
  assert.equal(m[0].view.kind, "table");
  assert.deepEqual(m[0].view.columns.map(c => c.key), ["purpose", "model", "from"]);
  assert.ok(m[0].view.rows.some(r => r.id === "purpose:chat"), "each row keeps an id to act on");
  assert.deepEqual(m[0].data, JSON.parse((await vyre("sessions", "models", "--json")).stdout));

  const p = await vyre("sessions", "prompt", "set", "--view");
  assert.equal(p.code, 2, p.out);
  const pf = frames(p.stdout);
  assert.deepEqual(pf[0].view, { kind: "prompt", name: "text", label: "The new system prompt", args: ["--text"] });
  assert.deepEqual(pf.at(-1), { v: 1, done: true, exit: 2 });
});
