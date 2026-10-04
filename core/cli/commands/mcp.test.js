// @ts-check
// `vyre mcp` verbs, --json and --view, in a temp home with no vyred: the real bin/vyre as a
// surface runs it (pipes, no terminal) and a fake `claude` on PATH that writes down its words.
// Serving itself is tested in connect.test.js.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../test/helpers.js";
import { INSTALL_LINE } from "./mcp.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, stdout: string, all: string }>} */
const run = (root, args, env = {}) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1", ...env }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, stdout, all: stdout + stderr })));

const frames = s => s.trim().split("\n").map(l => JSON.parse(l));

test("mcp: vyre commands lists serve and install, the verbs run() handles; any other is a usage mistake", async t => {
  const root = tempHome(t);
  const verbs = JSON.parse((await run(root, ["commands", "mcp", "--json"])).stdout).commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["serve", "install"]);
  assert.deepEqual(verbs[1].flags.map(f => f.name), ["yes", "json"]);
  const bad = await run(root, ["mcp", "frob"]);
  assert.equal(bad.code, 2, bad.all);
  assert.match(bad.all, /vyre mcp frob: not a verb/);
  assert.match(bad.all, /next: vyre mcp to serve/);
});

test("mcp --json: install prints the line, runs a fake claude only with --yes; serve refuses --json and --view at once", async t => {
  const root = tempHome(t);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const said = path.join(root, "claude-args");
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$@" > "${said}"\necho "Added stdio MCP server vyre"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };

  const dry = await run(root, ["mcp", "install", "--json"], env);
  assert.equal(dry.code, 0, dry.all);
  assert.deepEqual(JSON.parse(dry.stdout), { command: INSTALL_LINE, ran: false });
  assert.ok(!fs.existsSync(said), "without --yes, claude is not run");

  const yes = await run(root, ["mcp", "install", "--yes", "--json"], env);
  assert.equal(yes.code, 0, yes.all);
  assert.equal(yes.stdout.trim().split("\n").length, 1, "claude's own words stay out of stdout");
  assert.deepEqual(JSON.parse(yes.stdout), { command: INSTALL_LINE, ran: true, exit: 0, output: "Added stdio MCP server vyre" });
  assert.equal(fs.readFileSync(said, "utf8").trim(), "mcp add -s user vyre -- vyre mcp");

  const none = await run(root, ["mcp", "install", "--yes", "--json"], { PATH: path.join(root, "empty") });
  assert.equal(none.code, 1);
  assert.equal(JSON.parse(none.stdout).error.code, "no_claude");

  const view = frames((await run(root, ["mcp", "install", "--view"], env)).stdout);
  assert.deepEqual([view[0].cmd, view[0].view.kind, view[0].data.ran], ["mcp install", "card", false]);
  assert.deepEqual(view.at(-1), { v: 1, done: true, exit: 0 });

  // Serving with --json or --view would wait on stdin for ever: refused, exit 2, stdin still open.
  for (const args of [["mcp", "--json"], ["mcp", "serve", "--json"]]) {
    const r = await run(root, args);
    assert.equal(r.code, 2, r.all);
    assert.equal(JSON.parse(r.stdout).error.code, "bad_input");
  }
  const sv = frames((await run(root, ["mcp", "--view"])).stdout);
  assert.deepEqual([sv[0].view.kind, sv[0].view.code, sv.at(-1).exit], ["error", "bad_input", 2]);
});
